// P15.T02 / P15.TST.a / P15.SEC: cancelación individual de una rotación pendiente. `POST /rotations/{id}/cancel` es
// pública (sin sesión ni CSRF): recibe la firma EIP-712 `CancelRotation` de la U o la R vigentes, verifica la firma y
// la propuesta pendiente on-chain y la retransmite por el gas tank (worker real de la cola `gas-tank` →
// `cancelWithSignature` desde la cuenta gas tank); CANCELLED llega con el evento confirmado. Además la misma firma la
// puede transmitir cualquier relayer ajeno al backend. Una rotación cancelada no se ejecuta: ni por la API ni
// directo en el fork con firmas válidas de U y de S (el Guard revierte).
import { encodeFunctionData, getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import type { RotationView } from '../../src/rotations/service.ts';
import { executorAccount } from '../helpers/compromised-signer.ts';
import { resetRateLimits, until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  nextEmail,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepareRequest,
  propose,
  rotationRow,
  rotationView,
  signAndExecute,
  signCancel,
  syncRotations,
  warpTimelock,
} from '../helpers/rotations.ts';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rotationCancel });
  wallet = await activeWallet(env);
  // El worker de la cola `gas-tank` (el mismo handler del proceso gas-tank) consume las retransmisiones.
  env.base.startDeployWorker();
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, wallet);
});

/** Propone una rotación de S con U y la deja PENDING_TIMELOCK. */
async function pendingRotation(): Promise<RotationView> {
  const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
  await signAndExecute(env, wallet, operation, { role: 'U' });
  await syncRotations(env);
  const view = await rotationView(wallet, rotation.id);
  expect(view.status).toBe('PENDING_TIMELOCK');
  return view;
}

/** El relay público, sin cookies ni CSRF (como lo llamaría cualquier cliente o relayer). */
function relay(rotationId: string, signature: string) {
  return env.base.recovery.newClient().post(`/api/v1/rotations/${rotationId}/cancel`, { signature });
}

async function proposalStatus(id: Hex): Promise<number> {
  const proposal = await env.chain.public.readContract({
    address: env.base.snapshot.contracts.rotationTimelock,
    abi: rotationTimelockAbi,
    functionName: 'getProposal',
    args: [id],
  });
  return proposal.status;
}

/**
 * Espera a que el gas tank transmita la cancelación (status Cancelled on-chain y la retransmisión auditada, que se
 * escribe después del receipt) y la sincroniza.
 */
async function cancelledOnchain(view: RotationView): Promise<void> {
  const id = view.proposalId as Hex;
  await until(async () => ((await proposalStatus(id)) === 2 ? true : undefined), 60_000);
  await until(async () => {
    const relayed = await env.base.db.app
      .selectFrom('audit_events')
      .select('id')
      .where('event_type', '=', 'ROTATION_CANCEL_RELAYED')
      .where('target_id', '=', view.id)
      .executeTakeFirst();
    return relayed ? true : undefined;
  }, 60_000);
  await syncRotations(env);
}

describe('cancelación por firma individual', { timeout: 300_000 }, () => {
  it('U firma CancelRotation → el relay sin autenticación la verifica y el gas tank la transmite → CANCELLED; ya no se ejecuta', async () => {
    const view = await pendingRotation();
    const signature = await signCancel(wallet.userKey, view);
    const response = await relay(view.id, signature);
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      relay: { status: 'REQUESTED', signer: wallet.userKey.address, role: 'U' },
      rotation: { id: view.id, status: 'PENDING_TIMELOCK' },
    });
    await cancelledOnchain(view);
    const row = await rotationRow(env, view.id);
    expect(row).toMatchObject({ status: 'CANCELLED', cancelled_by: 'U' });
    const relayed = await env.base.db.app
      .selectFrom('chain_transactions')
      .select(['purpose', 'status'])
      .where('purpose', '=', 'CANCEL_RELAY')
      .execute();
    expect(relayed.length).toBeGreaterThanOrEqual(1);
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Rotación de clave cancelada');
    expect(email.text).toContain('tu clave de usuario');
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_type', '=', 'rotation')
      .where('target_id', '=', view.id)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual([
      'ROTATION_PROPOSAL_PREPARED',
      'ROTATION_PROPOSED',
      'ROTATION_CANCEL_REQUESTED',
      'ROTATION_CANCEL_RELAYED',
      'ROTATION_CANCELLED',
    ]);

    // Ejecución imposible: por la API (estado) y directo en el fork con U + S válidas aun pasadas las 48 h.
    await warpTimelock(env);
    const viaApi = await executePrepareRequest(wallet, { role: 'U' }, view.id);
    expect(viaApi.statusCode).toBe(409);
    const executor = executorAccount(env.base.executorShard, wallet.executor);
    await expect(directSwapOwner(view, executor)).rejects.toThrow();
    // Un segundo pedido de cancelación sobre una propuesta ya cancelada → 409.
    const again = await relay(view.id, signature);
    expect(again.statusCode).toBe(409);
  });

  it('R firma CancelRotation (desde Recovery) → CANCELLED con cancelledBy R', async () => {
    const view = await pendingRotation();
    const response = await relay(view.id, await signCancel(wallet.recoveryKey, view));
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ relay: { role: 'R', signer: wallet.recoveryKey.address } });
    await cancelledOnchain(view);
    expect(await rotationRow(env, view.id)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'R' });
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Rotación de clave cancelada');
    expect(email.text).toContain('tu clave de recuperación');
  });

  it('sin backend: la firma de U transmitida por un relayer ajeno cancela igual y el indexer lo refleja', async () => {
    const view = await pendingRotation();
    const signature = await signCancel(wallet.userKey, view);
    const outsider = privateKeyToAccount(generatePrivateKey());
    await env.chain.setBalance(outsider.address, 10n ** 17n);
    const hash = await env.chain
      .rpc<Hex>('eth_sendTransaction', [
        {
          from: outsider.address,
          to: env.base.snapshot.contracts.rotationTimelock,
          data: encodeFunctionData({
            abi: rotationTimelockAbi,
            functionName: 'cancelWithSignature',
            args: [view.proposalId as Hex, signature],
          }),
        },
      ])
      .catch(async () => {
        // Anvil sólo firma por cuentas desbloqueadas: el relayer ajeno firma su tx con su propia clave.
        const { createWalletClient, http } = await import('viem');
        const { base } = await import('viem/chains');
        const client = createWalletClient({ account: outsider, chain: base, transport: http(env.chain.url) });
        return client.writeContract({
          address: env.base.snapshot.contracts.rotationTimelock,
          abi: rotationTimelockAbi,
          functionName: 'cancelWithSignature',
          args: [view.proposalId as Hex, signature],
        });
      });
    const receipt = await env.chain.public.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(getAddress(receipt.from)).toBe(outsider.address);
    await syncRotations(env);
    expect(await rotationRow(env, view.id)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'U' });
  });
});

describe('rechazos del relay', { timeout: 300_000 }, () => {
  it('firma de una clave que no es U ni R → 422; rotación inexistente → 404; cuerpo inválido → 400', async () => {
    const view = await pendingRotation();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const foreign = await relay(view.id, await signCancel(stranger, view));
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    // La S vigente tampoco cancela ([C-RTL-03]: sólo U o R).
    const executor = executorAccount(env.base.executorShard, wallet.executor);
    const byExecutor = await relay(view.id, await signCancel(executor, view));
    expect(byExecutor.statusCode).toBe(422);
    const missing = await relay(crypto.randomUUID(), await signCancel(wallet.userKey, view));
    expect(missing.statusCode).toBe(404);
    const malformed = await relay(view.id, '0x1234');
    expect(malformed.statusCode).toBe(400);
    // La propuesta sigue pendiente: nada se transmitió.
    expect(await proposalStatus(view.proposalId as Hex)).toBe(1);
  });

  it('[B-RL] relay: 10 por hora por propuesta (bucket propio, sin sesión)', async () => {
    const view = await rotationView(wallet, (await latestPending()).id);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const signature = await signCancel(stranger, view);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await relay(view.id, signature)).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(422));
    expect(codes[10]).toBe(429);
    // Otra propuesta no comparte el bucket.
    const other = await relay(crypto.randomUUID(), signature);
    expect(other.statusCode).toBe(404);
  });
});

async function latestPending() {
  return env.base.db.app
    .selectFrom('rotation_requests')
    .select('id')
    .where('wallet_id', '=', wallet.walletId)
    .where('status', '=', 'PENDING_TIMELOCK')
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow();
}

/** `swapOwner(prev, S, S′)` ejecutado directo en la Safe con firmas válidas de U y de S (msg.sender = S). */
async function directSwapOwner(view: RotationView, executor: PrivateKeyAccount): Promise<void> {
  const owners = await env.chain.public.readContract({
    address: wallet.safe,
    abi: iSafeAbi,
    functionName: 'getOwners',
  });
  const index = owners.findIndex((o) => getAddress(o) === getAddress(view.oldKey));
  const prev = index === 0 ? '0x0000000000000000000000000000000000000001' : owners[index - 1];
  const data = encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'swapOwner',
    args: [prev!, view.oldKey, view.newKey],
  });
  const safeTx: SafeTx = {
    to: wallet.safe,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: await env.chain.safeNonce(wallet.safe),
  };
  const hash = safeTxHash(8453, wallet.safe, safeTx);
  const signed = await Promise.all(
    [wallet.userKey, executor].map(async (o) => ({ signer: o.address, signature: await o.sign({ hash }) })),
  );
  signed.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const signatures: Hex = `0x${signed.map((s) => s.signature.slice(2)).join('')}`;
  const { createWalletClient, http } = await import('viem');
  const { base } = await import('viem/chains');
  const client = createWalletClient({ account: executor, chain: base, transport: http(env.chain.url) });
  await env.chain.setBalance(executor.address, 10n ** 17n);
  // Simulación explícita: el Guard revierte (la propuesta está cancelada).
  await env.chain.public.simulateContract({
    account: executor,
    address: wallet.safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [safeTx.to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
  });
  await client.writeContract({
    address: wallet.safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [safeTx.to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
  });
}
