// P15.TST.b: ninguna rotación asistida sin 48 h ni fuera de [C-GRD-11]/[C-GRD-12], en tres capas independientes —
//   1. backend: la API y el prepare interno (la misma policy que usa toda ruta);
//   2. signer: la SafeTx firmada por U o R enviada directo por mTLS (un backend comprometido);
//   3. Guard on-chain: ejecución directa en el fork con firmas válidas del owner y de S (S descifrada del keystore del
//      shard: un host del signer comprometido), `msg.sender` = S.
// Casos: ejecución antes de las 48 h (RotationNotExecutable), propuesta con `old` ≠ rol vigente (RotationOldMismatch) y
// R + S proponiendo la rotación de R (RoleNotAllowed).
import { randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, getAddress, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import { decodeRevertReason } from '../../src/operations/chain-context.ts';
import { safeTxFromJson, safeTxToJson } from '../../src/operations/intent.ts';
import type { OperationActor, PrepareInput } from '../../src/operations/service.ts';
import { submissionCanonical } from '../../src/platform-session/request-signature.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { executorAccount } from '../helpers/compromised-signer.ts';
import { resetRateLimits, type Session } from '../helpers/onboarding.ts';
import {
  activeWallet,
  actorFor,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { signP256 } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepareRequest,
  propose,
  proposeRequest,
  recoverySession,
  signAndExecute,
  syncRotations,
} from '../helpers/rotations.ts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const SENTINEL: Address = '0x0000000000000000000000000000000000000001';

let env: OperationsEnv;
let wallet: ActiveWallet;
let executor: PrivateKeyAccount;
let rSession: Session;
let rActor: OperationActor;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rotationBypass });
  wallet = await activeWallet(env);
  executor = executorAccount(env.base.executorShard, wallet.executor);
  await env.chain.setBalance(executor.address, 10n ** 18n);
  rSession = await recoverySession(wallet);
  rActor = actorFor(wallet.onboarded.user.account.id, rSession);
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

function proposeCall(kind: number, oldValue: Address, newValue: Address) {
  return {
    to: env.base.snapshot.contracts.rotationTimelock,
    data: encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'propose', args: [kind, oldValue, newValue] }),
  };
}

async function swapOwnerCall(oldKey: Address, newKey: Address) {
  const owners = await env.chain.public.readContract({
    address: wallet.safe,
    abi: iSafeAbi,
    functionName: 'getOwners',
  });
  const index = owners.findIndex((o) => getAddress(o) === oldKey);
  const prev = index === 0 ? SENTINEL : getAddress(owners[index - 1] ?? SENTINEL);
  return {
    to: wallet.safe,
    data: encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [prev, oldKey, newKey] }),
  };
}

/** Capa 1: prepare interno. */
async function backendRejects(actor: OperationActor, input: Omit<PrepareInput, 'walletId'>, detail: string) {
  await expect(env.operations.prepare(actor, { walletId: wallet.walletId, ...input })).rejects.toMatchObject({
    code: 'POLICY_REJECTED',
    detail,
  });
}

/** Capa 2: SafeTx firmada por el owner (U o R) y envelope de su sesión, directo al signer. */
async function signerRefuses(
  operationType: string,
  call: { to: Address; data: Hex },
  owner: { role: 'U' | 'R'; key: PrivateKeyAccount; session: Pick<Session, 'token' | 'sessionId' | 'key'> },
  extra: Record<string, unknown> = {},
): Promise<SignerClientError> {
  const nonce = await env.chain.safeNonce(wallet.safe);
  const safeTx = safeTxToJson(buildSafeTx(call.to, call.data, nonce));
  const operationId = crypto.randomUUID();
  const hash = safeTxHash(8453, wallet.safe, safeTxFromJson(safeTx));
  const envelope = {
    operationId,
    safeTxHash: hash,
    sessionId: owner.session.sessionId,
    submittedAt: Math.floor(Date.now() / 1000),
  };
  const fees = await env.base.rpc.feeData();
  const accountNonce = await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' });
  const result = await env.base.executorShard.client
    .signSafeTx({
      operationId,
      walletId: wallet.walletId,
      safe: wallet.safe,
      chainId: 8453,
      operationType,
      safeTx,
      ownerSignature: await owner.key.sign({ hash }),
      ownerRole: owner.role,
      platformSessionToken: owner.session.token,
      submissionEnvelope: envelope,
      submissionEnvelopeSignature: signP256(owner.session.key, submissionCanonical(envelope)),
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
  expect(result, 'el signer co-firmó una rotación que debía rechazar').toBeInstanceOf(SignerClientError);
  return result as SignerClientError;
}

/** Capa 3: execTransaction con firmas válidas del owner y de S, enviada por S: motivo del revert y receipt. */
async function executeDirect(
  call: { to: Address; data: Hex },
  owner: PrivateKeyAccount,
): Promise<{ reason: string; status: 'success' | 'reverted' }> {
  const safeTx = buildSafeTx(call.to, call.data, await env.chain.safeNonce(wallet.safe));
  const hash = safeTxHash(8453, wallet.safe, safeTx);
  const signed = await Promise.all(
    [owner, executor].map(async (s) => ({ owner: s.address, sig: await s.sign({ hash }) })),
  );
  signed.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const signatures: Hex = `0x${signed.map((s) => s.sig.slice(2)).join('')}`;
  const args = [call.to, 0n, call.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] as const;
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

const uOwner = () => ({ role: 'U' as const, key: wallet.userKey, session: wallet.session });
const rOwner = () => ({ role: 'R' as const, key: wallet.recoveryKey, session: rSession });

describe('ejecución antes de las 48 h', { timeout: 300_000 }, () => {
  it('API 409 y prepare interno ROTATION_NOT_EXECUTABLE; signer ROTATION_NOT_EXECUTABLE; Guard RotationNotExecutable', async () => {
    await resetRateLimits(env.base.redis);
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    const call = await swapOwnerCall(rotation.oldKey, rotation.newKey);
    // 1. Backend.
    const api = await executePrepareRequest(wallet, { role: 'U' }, rotation.id);
    expect(api.statusCode).toBe(409);
    await backendRejects(
      wallet.actor,
      { operationType: 'ROTATION_EXECUTE', call, extraFacts: { newKeyIsSignerKey: true } },
      'ROTATION_NOT_EXECUTABLE',
    );
    // 2. Signer (con la atestación de S′: lo único que falta es la madurez).
    const attestation = await env.base.db.app
      .selectFrom('signer_keys')
      .select('attestation')
      .where('address', '=', Buffer.from(rotation.newKey.slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    const refused = await signerRefuses('ROTATION_EXECUTE', call, uOwner(), {
      newKeyAttestation: attestation.attestation,
    });
    expect(refused).toMatchObject({ code: 'POLICY_REJECTED', reason: 'ROTATION_NOT_EXECUTABLE' });
    // 3. Guard.
    const direct = await executeDirect(call, wallet.userKey);
    expect(direct).toEqual({ reason: 'RotationNotExecutable', status: 'reverted' });
    const owners = await env.chain.public.readContract({
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'getOwners',
    });
    expect(owners.map((o) => getAddress(o))).toContain(rotation.oldKey);
  });
});

describe('P15.SEC: cancelación sin el backend', { timeout: 300_000 }, () => {
  it('la firma CancelRotation de R (typed data armada sin la API) transmitida por un relayer cualquiera cancela on-chain', async () => {
    const timelock = env.base.snapshot.contracts.rotationTimelock;
    // La propuesta pendiente de S del caso anterior: el id sale del propio timelock, no de la plataforma.
    const id = await env.chain.public.readContract({
      address: timelock,
      abi: rotationTimelockAbi,
      functionName: 'activeProposal',
      args: [wallet.safe, RotationKind.Executor],
    });
    expect(id).not.toMatch(/^0x0{64}$/);
    const signature = await wallet.recoveryKey.signTypedData({
      domain: { name: 'MTW RotationTimelock', version: '1', chainId: 8453, verifyingContract: timelock },
      types: {
        CancelRotation: [
          { name: 'proposalId', type: 'bytes32' },
          { name: 'safe', type: 'address' },
        ],
      },
      primaryType: 'CancelRotation',
      message: { proposalId: id, safe: wallet.safe },
    });
    const relayer = privateKeyToAccount(generatePrivateKey());
    await env.chain.setBalance(relayer.address, 10n ** 17n);
    const client = createWalletClient({ account: relayer, chain: base, transport: http(env.chain.url) });
    const hash = await client.writeContract({
      address: timelock,
      abi: rotationTimelockAbi,
      functionName: 'cancelWithSignature',
      args: [id, signature],
    });
    const receipt = await env.chain.public.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const proposal = await env.chain.public.readContract({
      address: timelock,
      abi: rotationTimelockAbi,
      functionName: 'getProposal',
      args: [id],
    });
    expect(proposal.status).toBe(2);
    // La plataforma lo refleja al indexar RotationCancelled, aunque no participó de la cancelación.
    await syncRotations(env);
    const cancelled = await env.base.db.app
      .selectFrom('rotation_requests')
      .select(['status', 'cancelled_by'])
      .where('proposal_id', '=', Buffer.from(id.slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    expect(cancelled).toEqual({ status: 'CANCELLED', cancelled_by: 'R' });
    // Una firma de otra clave (ni U ni R) revierte en el timelock.
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = await stranger.signTypedData({
      domain: { name: 'MTW RotationTimelock', version: '1', chainId: 8453, verifyingContract: timelock },
      types: {
        CancelRotation: [
          { name: 'proposalId', type: 'bytes32' },
          { name: 'safe', type: 'address' },
        ],
      },
      primaryType: 'CancelRotation',
      message: { proposalId: `0x${(await rotationIdOf(rotation.id)).toString('hex')}`, safe: wallet.safe },
    });
    await expect(
      env.chain.public.simulateContract({
        account: relayer,
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'cancelWithSignature',
        args: [`0x${(await rotationIdOf(rotation.id)).toString('hex')}`, forged],
      }),
    ).rejects.toThrow(/NotCurrentUserOrRecovery|revert/);
  });
});

async function rotationIdOf(rotationId: string): Promise<Buffer> {
  const row = await env.base.db.app
    .selectFrom('rotation_requests')
    .select('proposal_id')
    .where('id', '=', rotationId)
    .executeTakeFirstOrThrow();
  if (row.proposal_id === null) throw new Error('la rotación no tiene propuesta on-chain');
  return row.proposal_id;
}

describe('propuesta con old distinto del rol vigente', { timeout: 300_000 }, () => {
  it('prepare interno ROTATION_INVALID; signer ROTATION_INVALID; Guard RotationOldMismatch', async () => {
    const call = proposeCall(RotationKind.User, random(), random());
    await backendRejects(
      wallet.actor,
      { operationType: 'ROTATION_PROPOSE', call, extraFacts: { keyAcceptanceValid: true } },
      'ROTATION_INVALID',
    );
    const refused = await signerRefuses('ROTATION_PROPOSE', call, uOwner());
    expect(refused).toMatchObject({ code: 'POLICY_REJECTED', reason: 'ROTATION_INVALID' });
    const direct = await executeDirect(call, wallet.userKey);
    expect(direct).toEqual({ reason: 'RotationOldMismatch', status: 'reverted' });
  });
});

describe('R + S proponiendo la rotación de R', { timeout: 300_000 }, () => {
  it('API 403; prepare interno con R ROTATION_INVALID; signer con R ROTATION_INVALID; Guard RoleNotAllowed', async () => {
    await resetRateLimits(env.base.redis);
    const api = await proposeRequest(wallet, { role: 'R', session: rSession }, 'R');
    expect(api.statusCode).toBe(403);
    const call = proposeCall(RotationKind.Recovery, wallet.recoveryKey.address, random());
    await backendRejects(
      rActor,
      { operationType: 'ROTATION_PROPOSE', call, extraFacts: { keyAcceptanceValid: true } },
      'ROTATION_INVALID',
    );
    const refused = await signerRefuses('ROTATION_PROPOSE', call, rOwner());
    expect(refused).toMatchObject({ code: 'POLICY_REJECTED', reason: 'ROTATION_INVALID' });
    const direct = await executeDirect(call, wallet.recoveryKey);
    expect(direct).toEqual({ reason: 'RoleNotAllowed', status: 'reverted' });
  });
});
