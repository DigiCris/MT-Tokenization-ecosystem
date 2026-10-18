// Lado cliente de las rotaciones (P15) para los tests, sobre el entorno de operaciones: sesión RECOVERY por step-up en
// el listener de Recovery (la misma cuenta en el otro origin), propuestas y ejecuciones por la API, firma de la SafeTx
// con U (Wallet) o con R (Recovery) y su envelope, ejecución por el pipeline real, sincronización con los eventos del
// RotationTimelock y firma EIP-712 `CancelRotation` sobre la typed data que devuelve la API.
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { expect } from 'vitest';
import type { PreparedOperation } from '../../src/operations/intent.ts';
import { submissionCanonical, type SubmissionEnvelope } from '../../src/platform-session/request-signature.ts';
import type { RotationView } from '../../src/rotations/service.ts';
import { critical, idempotencyKey, stepUp, type Session } from './onboarding.ts';
import {
  sessionOf,
  signSafeTx,
  statusOf,
  submissionBody,
  type ActiveWallet,
  type OperationsEnv,
  type SubmissionBody,
} from './operations.ts';
import { signP256 } from './platform.ts';

/** 48 h del RotationTimelock (DELAY) más un segundo. */
export const TIMELOCK_DELAY_SECONDS = 48 * 3600;

export interface RotationOperation {
  rotation: RotationView;
  operation: PreparedOperation;
}

/** Step-up RECOVERY en Recovery: PlatformSession de R (15 min). */
export function recoverySession(wallet: ActiveWallet): Promise<Session> {
  return stepUp(wallet.onboarded.user.recovery, wallet.onboarded.user.account.email, 'RECOVERY');
}

/** POST crítico en el listener de Recovery con la sesión de R. */
export function recoveryPost(wallet: ActiveWallet, session: Session, path: string, body: unknown = {}) {
  return critical(wallet.onboarded.user.recovery, session, path, body, { idempotencyKey: idempotencyKey() });
}

/** POST crítico en el listener de Wallet con la sesión OPERATIONS de U. */
export function userPost(wallet: ActiveWallet, path: string, body: unknown = {}) {
  return critical(wallet.onboarded.user.wallet, sessionOf(wallet), path, body, { idempotencyKey: idempotencyKey() });
}

/** Quién firma: U en Wallet (sesión OPERATIONS) o R en Recovery (sesión RECOVERY). */
export type Signer = { role: 'U' } | { role: 'R'; session: Session };

function post(wallet: ActiveWallet, signer: Signer, path: string, body: unknown = {}) {
  return signer.role === 'U' ? userPost(wallet, path, body) : recoveryPost(wallet, signer.session, path, body);
}

/** POST /wallets/{id}/rotations (la respuesta cruda, para los casos de rechazo). */
export function proposeRequest(wallet: ActiveWallet, signer: Signer, role: string) {
  return post(wallet, signer, `/wallets/${wallet.walletId}/rotations`, { role });
}

export async function propose(wallet: ActiveWallet, signer: Signer, role: string): Promise<RotationOperation> {
  const response = await proposeRequest(wallet, signer, role);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RotationOperation>();
}

export function executePrepareRequest(wallet: ActiveWallet, signer: Signer, rotationId: string) {
  return post(wallet, signer, `/rotations/${rotationId}/execute/prepare`);
}

export async function executePrepare(
  wallet: ActiveWallet,
  signer: Signer,
  rotationId: string,
): Promise<RotationOperation> {
  const response = await executePrepareRequest(wallet, signer, rotationId);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RotationOperation>();
}

/** Firma de R + envelope firmado con la session key de la sesión RECOVERY. */
export async function recoverySubmission(
  prepared: Pick<PreparedOperation, 'operationId' | 'safeTxHash' | 'safe' | 'safeTx' | 'chainId'>,
  recoveryKey: PrivateKeyAccount,
  session: Session,
): Promise<SubmissionBody> {
  const envelope: SubmissionEnvelope = {
    operationId: prepared.operationId,
    safeTxHash: prepared.safeTxHash,
    sessionId: session.sessionId,
    submittedAt: Math.floor(Date.now() / 1000),
  };
  return {
    ownerSignature: await signSafeTx(recoveryKey, prepared),
    ownerRole: 'R',
    submissionEnvelope: envelope,
    submissionEnvelopeSignature: signP256(session.key, submissionCanonical(envelope)),
  };
}

/** Firma la SafeTx con U o con R, la envía por la API y la ejecuta con el pipeline real (S vigente) → MINED. */
export async function signAndExecute(
  env: OperationsEnv,
  wallet: ActiveWallet,
  prepared: PreparedOperation,
  signer: Signer,
  recoveryKey: PrivateKeyAccount = wallet.recoveryKey,
): Promise<void> {
  const body =
    signer.role === 'U'
      ? await submissionBody(wallet, prepared)
      : await recoverySubmission(prepared, recoveryKey, signer.session);
  const response = await post(wallet, signer, `/operations/${prepared.operationId}/signatures`, body);
  expect(response.statusCode, response.body).toBe(200);
  await env.pipeline().processWallet(wallet.walletId);
  expect(await statusOf(env, prepared.operationId)).toBe('MINED');
}

/** Indexa lo minado, lo confirma (2 bloques) y aplica los eventos del timelock y la madurez. */
export async function syncRotations(env: OperationsEnv) {
  const indexer = env.indexer();
  await indexer.runOnce();
  await env.chain.mine(2);
  await indexer.runOnce();
  return env.rotationSync().runOnce();
}

export async function rotationRow(env: OperationsEnv, rotationId: string) {
  return env.base.db.app
    .selectFrom('rotation_requests')
    .selectAll()
    .where('id', '=', rotationId)
    .executeTakeFirstOrThrow();
}

export async function rotationView(wallet: ActiveWallet, rotationId: string): Promise<RotationView> {
  const response = await wallet.onboarded.user.wallet.get(`/api/v1/wallets/${wallet.walletId}/rotations`);
  expect(response.statusCode, response.body).toBe(200);
  const found = response.json<{ items: RotationView[] }>().items.find((r) => r.id === rotationId);
  if (!found) throw new Error(`rotación ${rotationId} no listada`);
  return found;
}

/** Firma EIP-712 `CancelRotation` con la typed data que devuelve la API (U o R vigentes; o cualquier clave). */
export async function signCancel(account: PrivateKeyAccount, view: RotationView): Promise<Hex> {
  const typed = view.cancelTypedData as {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    message: { proposalId: Hex; safe: Hex };
  } | null;
  if (typed === null) throw new Error('la rotación no tiene typed data de cancelación');
  const { EIP712Domain: _domain, ...types } = typed.types;
  return account.signTypedData({ domain: typed.domain, types, primaryType: 'CancelRotation', message: typed.message });
}

/** Avanza el reloj de la cadena hasta que la propuesta madure (48 h + 1 s). */
export async function warpTimelock(env: OperationsEnv): Promise<void> {
  await env.chain.increaseTime(TIMELOCK_DELAY_SECONDS + 1);
}
