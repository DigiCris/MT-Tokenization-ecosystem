// P14.TST.a / P14.SEC: toda vía de bypass termina en rechazo o revert, en tres capas independientes —
//   1. backend (API o prepare interno, la misma policy que usa toda ruta);
//   2. signer, con la SafeTx firmada por U enviada directo por mTLS (como lo haría un backend comprometido);
//   3. Guard on-chain, ejecutando directo en el fork con firmas válidas de U y de S (S descifrada del keystore del
//      shard: un host del signer comprometido) y `msg.sender` = S.
// Aserciones del threat model: A9 (destino no whitelisteado), A10 (approve a otro spender), A15 (allowance residual tras
// un swap), A16 (swap fuera del par o con minOut bajo el piso), A4 (llamada arbitraria) y A18 (el backend solo no altera
// la whitelist ni falsifica la autorización del usuario).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationWhitelistAbi, iSafeAbi, swapExecutorV3Abi } from '../../src/chain/abis/index.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import { Secret } from '../../src/config/secret.ts';
import { decodeRevertReason } from '../../src/operations/chain-context.ts';
import { safeTxFromJson, safeTxToJson } from '../../src/operations/intent.ts';
import type { PrepareInput } from '../../src/operations/service.ts';
import { PlatformSessionIssuer } from '../../src/platform-session/token.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { executorAccount } from '../helpers/compromised-signer.ts';
import { resetRateLimits } from '../helpers/onboarding.ts';
import {
  activeWallet,
  submissionBody,
  startOperationsEnv,
  USDC_HOLDER,
  walletPost,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const UNIT = 1_000_000n;

const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
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

let env: OperationsEnv;
let wallet: ActiveWallet;
let executor: PrivateKeyAccount;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.whitelistThreeLayers });
  wallet = await activeWallet(env);
  executor = executorAccount(env.base.executorShard, wallet.executor);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 200n * UNIT);
}, 600_000);

afterAll(async () => {
  await env.close();
});

const random = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

function buildSafeTx(to: Address, data: Hex, nonce: bigint): SafeTx {
  return {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };
}

/** Capa 1: prepare interno (la misma policy que usan todas las rutas de prepare). */
async function backendRejects(input: Omit<PrepareInput, 'walletId'>, code: string, detail?: string): Promise<void> {
  await expect(env.operations.prepare(wallet.actor, { walletId: wallet.walletId, ...input })).rejects.toMatchObject({
    code,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Capa 2: la SafeTx firmada por U (y el envelope de la sesión) directo al signer, sin operación del backend. */
async function signerRefuses(
  operationType: string,
  to: Address,
  data: Hex,
  extra: Record<string, unknown> = {},
): Promise<SignerClientError> {
  const nonce = await env.chain.safeNonce(wallet.safe);
  const safeTx = safeTxToJson(buildSafeTx(to, data, nonce));
  const forged = {
    operationId: crypto.randomUUID(),
    safe: wallet.safe,
    chainId: 8453,
    safeTx,
    safeTxHash: safeTxHash(8453, wallet.safe, safeTxFromJson(safeTx)),
  };
  const body = await submissionBody(wallet, forged);
  const fees = await env.base.rpc.feeData();
  const accountNonce = await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' });
  const result = await env.base.executorShard.client
    .signSafeTx({
      operationId: forged.operationId,
      walletId: wallet.walletId,
      safe: wallet.safe,
      chainId: 8453,
      operationType,
      safeTx,
      ownerSignature: body.ownerSignature,
      ownerRole: 'U',
      platformSessionToken: wallet.session.token,
      submissionEnvelope: body.submissionEnvelope,
      submissionEnvelopeSignature: body.submissionEnvelopeSignature,
      policySnapshotVersion: env.base.snapshot.version,
      execution: {
        accountNonce: String(accountNonce),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
      ...extra,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(result, 'el signer co-firmó una operación que debía rechazar').toBeInstanceOf(SignerClientError);
  return result as SignerClientError;
}

/**
 * Capa 3: execTransaction con firmas ECDSA válidas (ordenadas por owner) enviada por S. Devuelve el motivo del
 * revert (simulación) y el estado del receipt de la tx real.
 */
async function executeDirect(
  to: Address,
  data: Hex,
  signers: PrivateKeyAccount[] = [wallet.userKey, executor],
): Promise<{ reason: string; status: 'success' | 'reverted' }> {
  const nonce = await env.chain.safeNonce(wallet.safe);
  const safeTx = buildSafeTx(to, data, nonce);
  const hash = safeTxHash(8453, wallet.safe, safeTx);
  const signed = await Promise.all(signers.map(async (s) => ({ owner: s.address, sig: await s.sign({ hash }) })));
  signed.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const signatures: Hex = `0x${signed.map((s) => s.sig.slice(2)).join('')}`;
  const args = [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] as const;
  let reason = 'NO_REVERT';
  try {
    await env.chain.public.simulateContract({
      account: executor,
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'execTransaction',
      args,
    });
  } catch (error) {
    let current: unknown = error;
    let raw: Hex | null = null;
    for (let depth = 0; depth < 8 && current && raw === null; depth++) {
      const candidate = current as { raw?: unknown; data?: unknown };
      const value = candidate.data;
      if (typeof candidate.raw === 'string' && candidate.raw.startsWith('0x')) raw = candidate.raw as Hex;
      else if (typeof value === 'string' && value.startsWith('0x')) raw = value as Hex;
      else if (value && typeof (value as { data?: unknown }).data === 'string') raw = (value as { data: Hex }).data;
      current = (current as { cause?: unknown }).cause;
    }
    reason = decodeRevertReason(raw);
  }
  const client = createWalletClient({ account: executor, chain: base, transport: http(env.chain.url) });
  const txHash = await client.writeContract({
    address: wallet.safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args,
    gas: 1_500_000n,
  });
  const receipt = await env.chain.public.waitForTransactionReceipt({ hash: txHash });
  return { reason, status: receipt.status };
}

function transferCall(to: Address, amount: bigint) {
  return {
    to: env.base.snapshot.tokens.USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  };
}

function approveCall(spender: Address, amount: bigint) {
  return {
    to: env.base.snapshot.tokens.USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  };
}

function swapCall(tokenIn: Address, amountIn: bigint, minOut: bigint, deadline: bigint) {
  return {
    to: env.base.snapshot.contracts.swapExecutor,
    data: encodeFunctionData({
      abi: swapExecutorV3Abi,
      functionName: 'swap',
      args: [tokenIn, amountIn, minOut, deadline],
    }),
  };
}

async function deadline(): Promise<bigint> {
  const block = await env.chain.public.getBlock({ blockTag: 'latest' });
  return block.timestamp + 300n;
}

describe('A9: destino no whitelisteado', () => {
  it('API manipulada → 422; directo al signer → POLICY_REJECTED; U+S directo on-chain → revert DestinationNotWhitelisted', async () => {
    await resetRateLimits(env.base.redis);
    const destination = random();
    const usdc = env.base.snapshot.tokens.USDC;
    const before = await env.chain.tokenBalance(usdc, wallet.safe);
    // 1. Backend: la API recibe un destino que la UI nunca ofrecería (request interceptado).
    const api = await walletPost(wallet, `/wallets/${wallet.walletId}/send/prepare`, {
      token: 'USDC',
      destination,
      amount: (10n * UNIT).toString(),
    });
    expect(api.statusCode).toBe(422);
    expect(api.json()).toMatchObject({ code: 'POLICY_REJECTED', detail: 'DESTINATION_NOT_WHITELISTED' });
    const call = transferCall(destination, 10n * UNIT);
    await backendRejects({ operationType: 'SEND', call }, 'POLICY_REJECTED', 'DESTINATION_NOT_WHITELISTED');
    // 2. Signer: la SafeTx firmada por U, sin pasar por el backend.
    const refused = await signerRefuses('SEND', call.to, call.data);
    expect(refused.code).toBe('POLICY_REJECTED');
    expect(refused.reason).toBe('DESTINATION_NOT_WHITELISTED');
    // 3. Guard: firmas válidas de U y S, enviada por S.
    const direct = await executeDirect(call.to, call.data);
    expect(direct).toEqual({ reason: 'DestinationNotWhitelisted', status: 'reverted' });
    expect(await env.chain.tokenBalance(usdc, wallet.safe)).toBe(before);
    expect(await env.chain.tokenBalance(usdc, destination)).toBe(0n);
  });
});

describe('A10: approve a un spender que no es el SwapExecutor', () => {
  it('backend UNKNOWN_OPERATION; signer lo rechaza; on-chain revierte y no queda allowance', async () => {
    const spender = random();
    const call = approveCall(spender, 50n * UNIT);
    await backendRejects({ operationType: 'SWAP_APPROVE', call }, 'POLICY_REJECTED', 'UNKNOWN_OPERATION');
    const refused = await signerRefuses('SWAP_APPROVE', call.to, call.data);
    expect(['POLICY_REJECTED', 'STATIC_RULE_VIOLATION']).toContain(refused.code);
    const direct = await executeDirect(call.to, call.data);
    expect(direct.status).toBe('reverted');
    expect(direct.reason).toMatch(/^[A-Z][A-Za-z]+$/);
    const allowance = await env.chain.public.readContract({
      address: env.base.snapshot.tokens.USDC,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.safe, spender],
    });
    expect(allowance).toBe(0n);
  });
});

describe('A16: swap fuera del par o con minOut bajo el piso', () => {
  it('minOut 60 bps bajo la paridad: backend SLIPPAGE_TOO_HIGH; signer rechaza; on-chain revierte MinOutBelowFloor', async () => {
    const amountIn = 10n * UNIT;
    const call = swapCall(env.base.snapshot.tokens.USDC, amountIn, (amountIn * 9_940n) / 10_000n, await deadline());
    await backendRejects({ operationType: 'SWAP', call }, 'POLICY_REJECTED', 'SLIPPAGE_TOO_HIGH');
    const refused = await signerRefuses('SWAP', call.to, call.data);
    expect(refused.code).toBe('POLICY_REJECTED');
    expect(refused.reason).toBe('SLIPPAGE_TOO_HIGH');
    expect(await executeDirect(call.to, call.data)).toEqual({ reason: 'MinOutBelowFloor', status: 'reverted' });
  });

  it('token arbitrario (WETH): backend UNKNOWN_OPERATION; signer rechaza; on-chain revierte', async () => {
    const weth: Address = '0x4200000000000000000000000000000000000006';
    const call = swapCall(weth, 10n * UNIT, 9_990_000n, await deadline());
    await backendRejects({ operationType: 'SWAP', call }, 'POLICY_REJECTED', 'UNKNOWN_OPERATION');
    const refused = await signerRefuses('SWAP', call.to, call.data);
    expect(['POLICY_REJECTED', 'STATIC_RULE_VIOLATION']).toContain(refused.code);
    const direct = await executeDirect(call.to, call.data);
    expect(direct.status).toBe('reverted');
    expect(direct.reason).toMatch(/^[A-Z][A-Za-z]+$/);
  });
});

describe('A15: allowance residual después de un swap', () => {
  it('approve mayor que el swap: backend y signer rechazan el par; on-chain el swap revierte por la post-condición', async () => {
    const s = env.base.snapshot;
    const amountIn = 10n * UNIT;
    // 1 y 2: el approve por 11 emparejado con un swap por 10 no pasa (quedaría allowance).
    await expect(
      env.operations.prepareSwapGroup(wallet.actor, {
        walletId: wallet.walletId,
        groupId: null,
        tokenIn: s.tokens.USDC,
        tokenOut: s.tokens.USDT,
        amountIn,
        quote: {
          expectedOut: '0',
          minOut: '0',
          slippageBps: 30,
          priceImpactBps: 0,
          deadline: '0',
          blockNumber: '0',
          quotedAt: new Date().toISOString(),
        },
        approve: approveCall(s.contracts.swapExecutor, amountIn + UNIT),
        swap: swapCall(s.tokens.USDC, amountIn, 9_990_000n, await deadline()),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED', detail: 'SWAP_PAIRING_INVALID' });
    const approve = approveCall(s.contracts.swapExecutor, amountIn + UNIT);
    // El approve solo, sin su SWAP N+1 firmado al lado, no se co-firma ([B-SIG-02]).
    const refused = await signerRefuses('SWAP_APPROVE', approve.to, approve.data);
    expect(refused.code).toBe('POLICY_REJECTED');
    expect(refused.reason).toBe('SWAP_PAIRING_INVALID');
    // 3: con U+S directo el approve a SwapExecutor pasa (única excepción del Guard), pero el swap por menos revierte.
    expect((await executeDirect(approve.to, approve.data)).status).toBe('success');
    const swap = swapCall(s.tokens.USDC, amountIn, 9_990_000n, await deadline());
    expect(await executeDirect(swap.to, swap.data)).toEqual({ reason: 'SwapPostConditionFailed', status: 'reverted' });
    // Limpieza: revocar con U+S.
    const revoke = approveCall(s.contracts.swapExecutor, 0n);
    expect((await executeDirect(revoke.to, revoke.data)).status).toBe('success');
  });
});

describe('A4: llamada arbitraria', () => {
  it('calldata a un contrato fuera del sistema: backend UNKNOWN_OPERATION; signer rechaza; on-chain revierte', async () => {
    const call = { to: random(), data: '0xdeadbeef' as Hex };
    await backendRejects({ operationType: 'SEND', call }, 'POLICY_REJECTED', 'UNKNOWN_OPERATION');
    const refused = await signerRefuses('SEND', call.to, call.data);
    expect(['POLICY_REJECTED', 'STATIC_RULE_VIOLATION']).toContain(refused.code);
    const direct = await executeDirect(call.to, call.data);
    expect(direct.status).toBe('reverted');
    expect(direct.reason).toMatch(/^[A-Z][A-Za-z]+$/);
  });
});

describe('A18: el backend solo no altera la whitelist ni falsifica la autorización del usuario', () => {
  it('sin challenge: backend CHALLENGE_REQUIRED; atestación falsificada o ausente: el signer no co-firma', async () => {
    const destination = random();
    const call = {
      to: env.base.snapshot.contracts.destinationWhitelist,
      data: encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'addDestination', args: [destination] }),
    };
    await backendRejects({ operationType: 'WHITELIST_ADD', call }, 'POLICY_REJECTED', 'CHALLENGE_REQUIRED');
    const missing = await signerRefuses('WHITELIST_ADD', call.to, call.data);
    expect(missing).toMatchObject({ code: 'POLICY_REJECTED', reason: 'CHALLENGE_REQUIRED' });
    // ChallengeCompletion con el kid del emisor pero firmada con otra clave (un backend sin la clave del emisor).
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const forger = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: env.issuer.kid });
    const nonce = await env.chain.safeNonce(wallet.safe);
    const forgedAttestation = await forger.signChallengeCompletion({
      challengeId: crypto.randomUUID(),
      type: 'WHITELIST_ADD',
      userId: wallet.onboarded.user.account.id,
      safe: wallet.safe,
      chainId: 8453,
      action: 'WHITELIST_ADD',
      destination,
      safeTxHash: safeTxHash(8453, wallet.safe, buildSafeTx(call.to, call.data, nonce)),
      nonce: Number(nonce),
      completedAt: Math.floor(Date.now() / 1000),
    });
    const forged = await signerRefuses('WHITELIST_ADD', call.to, call.data, {
      challengeAttestation: forgedAttestation,
    });
    expect(forged).toMatchObject({ code: 'POLICY_REJECTED', reason: 'CHALLENGE_REQUIRED' });
  });

  it('on-chain: S llamando directo sólo toca su propia lista y sin la firma de U la Safe no ejecuta el alta', async () => {
    const destination = random();
    const whitelist = env.base.snapshot.contracts.destinationWhitelist;
    const client = createWalletClient({ account: executor, chain: base, transport: http(env.chain.url) });
    const hash = await client.writeContract({
      address: whitelist,
      abi: destinationWhitelistAbi,
      functionName: 'addDestination',
      args: [destination],
    });
    expect((await env.chain.public.waitForTransactionReceipt({ hash })).status).toBe('success');
    const [onSafe] = await env.chain.public.readContract({
      address: whitelist,
      abi: destinationWhitelistAbi,
      functionName: 'destinationInfo',
      args: [wallet.safe, destination],
    });
    expect(onSafe).toBe(false);
    // execTransaction del alta con la firma de S y la de una clave que no es owner (no hay firma de U).
    const data = encodeFunctionData({
      abi: destinationWhitelistAbi,
      functionName: 'addDestination',
      args: [destination],
    });
    const stranger = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
    const direct = await executeDirect(whitelist, data, [stranger, executor]);
    expect(direct.status).toBe('reverted');
    expect(direct.reason).toMatch(/^GS0\d\d$/);
    const [after] = await env.chain.public.readContract({
      address: whitelist,
      abi: destinationWhitelistAbi,
      functionName: 'destinationInfo',
      args: [wallet.safe, destination],
    });
    expect(after).toBe(false);
  });
});
