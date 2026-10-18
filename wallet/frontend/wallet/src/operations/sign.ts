// Firma y envío de una operación del camino asistido (P18, contrato A.1 del backend). La app ya verificó la operación
// contra la SafeTx que armó ella misma (chain/safe-tx.ts → verifyPrepared): U firma el hash local, descifrada sólo
// durante esa firma ([F-KEY-05]); el envelope de envío ([B-PSES-06]) ata la firma a esa operación, ese hash y esa
// PlatformSession, con la hora alineada con el servidor (±60 s). Después se sigue el estado hasta que la operación se
// mina, falla o se cancela.
import type { OperationState, OperationStatus, WalletApi } from '../api/wallet-api.ts';
import { signSubmission } from '../api/submission.ts';
import type { VerifiedOperation } from '../chain/safe-tx.ts';
import { fromHex } from '../crypto/bytes.ts';
import { signDigest, withKey } from '../crypto/sign.ts';
import type { UnlockedWallet } from '../unlock/unlock.ts';

/** La operación ya está en la cadena (o confirmada y final). */
export const SETTLED_STATES: readonly OperationState[] = ['MINED', 'CONFIRMED', 'FINALIZED'];
/** Ya no va a ejecutarse. */
export const DEAD_STATES: readonly OperationState[] = ['FAILED_FINAL', 'CANCELLED', 'EXPIRED'];

export async function signAndSubmit(
  api: WalletApi,
  unlocked: UnlockedWallet,
  verified: VerifiedOperation,
  options: { twoFactorChallengeId?: string } = {},
): Promise<OperationStatus> {
  const { operationId } = verified.operation;
  const ownerSignature = await withKey(unlocked.envelope, unlocked.encryptionKey, (key) =>
    signDigest(fromHex(verified.hash), key),
  );
  const { submissionEnvelope, submissionEnvelopeSignature } = await signSubmission(
    unlocked.platform.key,
    { operationId, safeTxHash: verified.hash, sessionId: unlocked.platform.sessionId },
    api.client.now(),
  );
  return api.submitOperationSignature(unlocked.platform, operationId, {
    ownerSignature,
    ownerRole: 'U',
    submissionEnvelope,
    submissionEnvelopeSignature,
    ...(options.twoFactorChallengeId === undefined ? {} : { twoFactorChallengeId: options.twoFactorChallengeId }),
  });
}

export interface WaitOptions {
  /** Estados en los que se deja de esperar (por defecto: en la cadena o muerta). */
  until?: readonly OperationState[];
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (status: OperationStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class OperationWaitTimeout extends Error {
  override name = 'OperationWaitTimeout';
  readonly last: OperationStatus | null;

  constructor(last: OperationStatus | null) {
    super('La operación sigue en curso: podés ver su estado en Actividad.');
    this.last = last;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sigue el estado de la operación hasta uno de `until` (por defecto, en la cadena o muerta). */
export async function waitForOperation(
  api: WalletApi,
  operationId: string,
  options: WaitOptions = {},
): Promise<OperationStatus> {
  const until = options.until ?? [...SETTLED_STATES, ...DEAD_STATES];
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const last = await api.operation(operationId);
    options.onUpdate?.(last);
    if (until.includes(last.status)) return last;
    if (now() >= deadline) throw new OperationWaitTimeout(last);
    await sleep(options.intervalMs ?? 2_000);
  }
}
