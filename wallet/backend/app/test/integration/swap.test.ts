// P14.T05 / P14.TST.d: swaps reales contra el pool canónico del fork y el shard real del signer. El par approve exacto
// (nonce N) + swap (N+1) se firma junto y se encola recién con las dos firmas; el worker los ejecuta en orden, la
// salida vuelve a la Safe y la allowance final es 0 (USDC→USDT y USDT→USDC). Un par incompleto se descarta (nonce
// liberado); un swap que falla en forma definitiva con el approve ejecutado deja el grupo FAILED con la allowance
// residual notificada y se ofrece re-cotizar (par nuevo) o revocarla. minOut bajo el piso y token arbitrario se
// rechazan en el backend (el signer y el Guard: test/security/whitelist-three-layers.test.ts).
import { encodeFunctionData, type Abi, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { swapExecutorV3Abi } from '../../src/chain/abis/index.ts';
import type { OperationView, PreparedOperation } from '../../src/operations/intent.ts';
import { resetRateLimits } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  operationRow,
  settle,
  startOperationsEnv,
  statusOf,
  submissionBody,
  submitSignature,
  USDC_HOLDER,
  USDT_HOLDER,
  walletPost,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const UNIT = 1_000_000n;

const allowanceAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

interface PreparedSwap {
  group: { id: string; status: string; nextActions: string[] };
  quote: { expectedOut: string; minOut: string; deadline: string; amountIn: string };
  operations: [PreparedOperation, PreparedOperation];
}

interface GroupView {
  id: string;
  status: string;
  failureReason: string | null;
  nextActions: string[];
  operations: OperationView[];
}

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.swap });
  wallet = await activeWallet(env);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 500n * UNIT);
  await env.chain.fund(env.base.snapshot.tokens.USDT, USDT_HOLDER, wallet.safe, 500n * UNIT);
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, wallet);
});

const token = (symbol: 'USDC' | 'USDT'): Address => env.base.snapshot.tokens[symbol];

async function allowance(symbol: 'USDC' | 'USDT'): Promise<bigint> {
  return env.chain.public.readContract({
    address: token(symbol),
    abi: allowanceAbi,
    functionName: 'allowance',
    args: [wallet.safe, env.base.snapshot.contracts.swapExecutor],
  });
}

async function prepareSwap(tokenIn: 'USDC' | 'USDT', amountIn: bigint, slippageBps = 30): Promise<PreparedSwap> {
  const response = await walletPost(wallet, `/wallets/${wallet.walletId}/swap/prepare`, {
    tokenIn,
    amountIn: amountIn.toString(),
    slippageBps,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PreparedSwap>();
}

async function sign(prepared: PreparedOperation): Promise<OperationView> {
  const response = await submitSignature(wallet, prepared.operationId, await submissionBody(wallet, prepared));
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OperationView>();
}

async function group(id: string): Promise<GroupView> {
  const response = await wallet.onboarded.user.wallet.get(`/api/v1/operation-groups/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<GroupView>();
}

async function swapAndCheck(tokenIn: 'USDC' | 'USDT') {
  const tokenOut = tokenIn === 'USDC' ? 'USDT' : 'USDC';
  const amountIn = 100n * UNIT;
  const prepared = await prepareSwap(tokenIn, amountIn);
  const [approve, swap] = prepared.operations;
  expect(prepared.group.status).toBe('OPEN');
  expect(BigInt(swap.safeTx.nonce)).toBe(BigInt(approve.safeTx.nonce) + 1n);
  expect(approve).toMatchObject({
    operationType: 'SWAP_APPROVE',
    groupId: prepared.group.id,
    decoded: { token: tokenIn, amount: amountIn.toString() },
    safeTx: { to: token(tokenIn) },
  });
  expect(swap).toMatchObject({
    operationType: 'SWAP',
    groupId: prepared.group.id,
    decoded: {
      tokenIn,
      tokenOut,
      amount: amountIn.toString(),
      minAmountOut: prepared.quote.minOut,
      deadline: prepared.quote.deadline,
    },
    safeTx: { to: env.base.snapshot.contracts.swapExecutor },
  });
  const inBefore = await env.chain.tokenBalance(token(tokenIn), wallet.safe);
  const outBefore = await env.chain.tokenBalance(token(tokenOut), wallet.safe);
  // La firma del approve sola no encola nada; con la del swap se encolan las dos.
  expect((await sign(approve)).status).toBe('USER_SIGNED');
  expect((await sign(swap)).status).toBe('QUEUED');
  expect(await statusOf(env, approve.operationId)).toBe('QUEUED');
  await env.pipeline().processWallet(wallet.walletId);
  const [approveRow, swapRow] = await Promise.all([
    operationRow(env, approve.operationId),
    operationRow(env, swap.operationId),
  ]);
  expect([approveRow.status, swapRow.status]).toEqual(['MINED', 'MINED']);
  expect(BigInt(approveRow.block_number ?? '0')).toBeLessThan(BigInt(swapRow.block_number ?? '0'));
  // Resultado a la Safe, salida ≥ minOut y allowance final 0 (A15).
  expect(await env.chain.tokenBalance(token(tokenIn), wallet.safe)).toBe(inBefore - amountIn);
  const received = (await env.chain.tokenBalance(token(tokenOut), wallet.safe)) - outBefore;
  expect(received).toBeGreaterThanOrEqual(BigInt(prepared.quote.minOut));
  expect(await allowance(tokenIn)).toBe(0n);
  await settle(env, swap.operationId, 'CONFIRMED');
  await env.swapCoordinator().runOnce();
  const done = await group(prepared.group.id);
  expect(done).toMatchObject({ status: 'COMPLETED', nextActions: [] });
  expect(done.operations.map((o) => o.operationType)).toEqual(['SWAP_APPROVE', 'SWAP']);
}

describe('swap USDC↔USDT', () => {
  it('USDC→USDT real: approve exacto (N) + swap (N+1), en orden; salida ≥ minOut y allowance final 0', async () => {
    await swapAndCheck('USDC');
  });

  it('USDT→USDC real', async () => {
    await swapAndCheck('USDT');
  });

  it('firmar sólo el approve no encola nada; si el swap vence, el approve se descarta y el nonce se libera', async () => {
    const prepared = await prepareSwap('USDC', 20n * UNIT);
    const [approve, swap] = prepared.operations;
    expect((await sign(approve)).status).toBe('USER_SIGNED');
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, approve.operationId)).toBe('USER_SIGNED');
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', swap.operationId)
      .execute();
    await env.operations.sweep();
    expect(await statusOf(env, swap.operationId)).toBe('EXPIRED');
    const result = await env.swapCoordinator().runOnce();
    expect(result.discarded).toBe(1);
    expect(await operationRow(env, approve.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      failure_reason: 'PAIR_INCOMPLETE',
    });
    expect((await group(prepared.group.id)).status).toBe('CANCELLED');
    // Los dos nonces quedaron libres: el próximo par vuelve a ocuparlos.
    const next = await prepareSwap('USDC', 20n * UNIT);
    expect(next.operations[0].safeTx.nonce).toBe(approve.safeTx.nonce);
    await expireCreated(env, wallet);
  });

  it('cancelar una mitad sin encolar descarta el par entero sin NoOp', async () => {
    const prepared = await prepareSwap('USDT', 20n * UNIT);
    const [approve, swap] = prepared.operations;
    await sign(approve);
    const cancelled = await walletPost(wallet, `/operations/${swap.operationId}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ operation: { status: 'CANCELLED' }, noop: null });
    expect(await operationRow(env, approve.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      failure_reason: 'USER_CANCELLED',
    });
    expect((await group(prepared.group.id)).status).toBe('CANCELLED');
  });

  it('swap vencido con el approve ejecutado: FAILED con allowance residual notificada → re-cotización con un par nuevo', async () => {
    const amountIn = 30n * UNIT;
    const prepared = await prepareSwap('USDC', amountIn);
    const [approve, swap] = prepared.operations;
    await sign(approve);
    await sign(swap);
    // Cada bloque nuevo avanza 700 s: el approve se co-firma a tiempo, pero el swap (deadline +600 s) llega vencido.
    await env.chain.rpc('anvil_setBlockTimestampInterval', [700]);
    try {
      await env.pipeline().processWallet(wallet.walletId);
    } finally {
      await env.chain.rpc('anvil_removeBlockTimestampInterval');
    }
    expect(await statusOf(env, approve.operationId)).toBe('MINED');
    expect(await operationRow(env, swap.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'POLICY_REJECTED',
      failure_reason: 'POLICY_REJECTED: DEADLINE_INVALID',
    });
    expect(await allowance('USDC')).toBe(amountIn);
    await settle(env, approve.operationId, 'CONFIRMED');
    const coordinator = env.swapCoordinator();
    const run = await coordinator.runOnce();
    expect(run.residual).toBe(1);
    const failed = await group(prepared.group.id);
    expect(failed).toMatchObject({ status: 'FAILED', nextActions: ['REQUOTE', 'REVOKE_APPROVAL'] });
    const notifications = await env.base.db.app
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('user_id', '=', wallet.onboarded.user.account.id)
      .where('type', 'in', ['SWAP_FAILED', 'RESIDUAL_ALLOWANCE'])
      .execute();
    expect(notifications.map((n) => n.type).sort()).toEqual(['RESIDUAL_ALLOWANCE', 'SWAP_FAILED']);
    expect(notifications.find((n) => n.type === 'RESIDUAL_ALLOWANCE')?.payload).toMatchObject({
      groupId: prepared.group.id,
      allowance: amountIn.toString(),
    });
    // La limpieza avisa una sola vez.
    expect((await coordinator.runOnce()).residual).toBe(0);

    // Re-cotización: par nuevo (approve + swap) en los nonces siguientes, en el mismo grupo.
    const requote = await walletPost(wallet, `/operation-groups/${prepared.group.id}/requote`, { slippageBps: 30 });
    expect(requote.statusCode, requote.body).toBe(200);
    const again = requote.json<PreparedSwap>();
    expect(again.group).toMatchObject({ id: prepared.group.id, status: 'OPEN' });
    const [approve2, swap2] = again.operations;
    expect(BigInt(approve2.safeTx.nonce)).toBe(BigInt(swap.safeTx.nonce));
    expect(BigInt(swap2.safeTx.nonce)).toBe(BigInt(swap.safeTx.nonce) + 1n);
    await sign(approve2);
    await sign(swap2);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, swap2.operationId)).toBe('MINED');
    expect(await allowance('USDC')).toBe(0n);
    await settle(env, swap2.operationId, 'CONFIRMED');
    await coordinator.runOnce();
    expect((await group(prepared.group.id)).status).toBe('COMPLETED');
    // Un grupo completo no admite otra cotización.
    expect((await walletPost(wallet, `/operation-groups/${prepared.group.id}/requote`, {})).statusCode).toBe(409);
  });

  it('swap vencido → revocación de la allowance (APPROVE_REVOKE) → grupo CANCELLED con allowance 0', async () => {
    const amountIn = 25n * UNIT;
    const prepared = await prepareSwap('USDT', amountIn);
    const [approve, swap] = prepared.operations;
    await sign(approve);
    await sign(swap);
    await env.chain.rpc('anvil_setBlockTimestampInterval', [700]);
    try {
      await env.pipeline().processWallet(wallet.walletId);
    } finally {
      await env.chain.rpc('anvil_removeBlockTimestampInterval');
    }
    expect(await allowance('USDT')).toBe(amountIn);
    await settle(env, approve.operationId, 'CONFIRMED');
    await env.swapCoordinator().runOnce();
    expect((await group(prepared.group.id)).status).toBe('FAILED');
    const revoke = await walletPost(wallet, `/operation-groups/${prepared.group.id}/revoke-approval`, {});
    expect(revoke.statusCode, revoke.body).toBe(200);
    const revokeOp = revoke.json<PreparedOperation>();
    expect(revokeOp).toMatchObject({
      operationType: 'APPROVE_REVOKE',
      groupId: prepared.group.id,
      decoded: { token: 'USDT', amount: '0' },
    });
    expect((await sign(revokeOp)).status).toBe('QUEUED');
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, revokeOp.operationId)).toBe('MINED');
    expect(await allowance('USDT')).toBe(0n);
    await settle(env, revokeOp.operationId, 'CONFIRMED');
    await env.swapCoordinator().runOnce();
    expect((await group(prepared.group.id)).status).toBe('CANCELLED');
  });

  it('backend: minOut bajo el piso, approve distinto del swap y token arbitrario se rechazan antes de crear nada', async () => {
    const s = env.base.snapshot;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const swapCall = (tokenIn: Address, amountIn: bigint, minOut: bigint) => ({
      to: s.contracts.swapExecutor,
      data: encodeFunctionData({
        abi: swapExecutorV3Abi,
        functionName: 'swap',
        args: [tokenIn, amountIn, minOut, deadline],
      }),
    });
    const approveCall = (tokenAddress: Address, amount: bigint) => ({
      to: tokenAddress,
      data: encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'approve',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ] as const,
        functionName: 'approve',
        args: [s.contracts.swapExecutor, amount],
      }),
    });
    const base = {
      walletId: wallet.walletId,
      groupId: null,
      tokenIn: s.tokens.USDC,
      tokenOut: s.tokens.USDT,
      amountIn: 10n * UNIT,
      quote: {
        expectedOut: '0',
        minOut: '0',
        slippageBps: 30,
        priceImpactBps: 0,
        deadline: deadline.toString(),
        blockNumber: '0',
        quotedAt: new Date().toISOString(),
      },
    };
    const before = await env.base.db.app
      .selectFrom('wallet_operations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    // minOut 60 bps debajo de la paridad (el piso on-chain es 50 bps).
    await expect(
      env.operations.prepareSwapGroup(wallet.actor, {
        ...base,
        approve: approveCall(s.tokens.USDC, 10n * UNIT),
        swap: swapCall(s.tokens.USDC, 10n * UNIT, (10n * UNIT * 9_940n) / 10_000n),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED', detail: 'SLIPPAGE_TOO_HIGH' });
    // Approve por más de lo que usa el swap (quedaría allowance residual).
    await expect(
      env.operations.prepareSwapGroup(wallet.actor, {
        ...base,
        approve: approveCall(s.tokens.USDC, 11n * UNIT),
        swap: swapCall(s.tokens.USDC, 10n * UNIT, 9_990_000n),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED', detail: 'SWAP_PAIRING_INVALID' });
    // Token fuera del par (WETH de Base).
    const weth: Address = '0x4200000000000000000000000000000000000006';
    await expect(
      env.operations.prepareSwapGroup(wallet.actor, {
        ...base,
        approve: approveCall(weth, 10n * UNIT),
        swap: swapCall(weth, 10n * UNIT, 9_990_000n),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED', detail: 'UNKNOWN_OPERATION' });
    // Por la API el par sólo puede ser USDC/USDT.
    const viaApi = await walletPost(wallet, `/wallets/${wallet.walletId}/swap/prepare`, {
      tokenIn: 'WETH',
      amountIn: '10000000',
    });
    expect(viaApi.statusCode).toBe(400);
    const after = await env.base.db.app
      .selectFrom('wallet_operations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});
