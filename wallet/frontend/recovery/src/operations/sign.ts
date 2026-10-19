// Firma y envío de una operación por R (P19.T04/T05/T10): la SafeTx ya verificada contra la que arma la app; R firma su
// typed data (interna: el digest; externa: `eth_signTypedData_v4`), la firma tiene que recuperar a R y quedar en el
// formato estricto; la session key firma el sobre de envío [B-PSES-06]. Después se sigue el estado de la operación.
import { isAddressEqual, recoverAddress } from 'viem';
import type { OperationState, OperationStatus, PreparedOperation, RecoveryApi } from '../api/recovery-api.ts';
import { signSubmission } from '../api/submission.ts';
import type { VerifiedOperation } from '../chain/safe-tx.ts';
import { strictSignature } from '../enroll/enrollment.ts';
import type { PlatformSession } from '../session/store.ts';
import { signSafeTx, type RecoverySigner } from '../signer/recovery-signer.ts';

export const SETTLED_STATES: readonly OperationState[] = ['MINED', 'CONFIRMED', 'FINALIZED'];
export const DEAD_STATES: readonly OperationState[] = ['FAILED_FINAL', 'CANCELLED', 'EXPIRED'];

export class RecoverySignatureError extends Error {
  override name = 'RecoverySignatureError';
}

export async function submitRecoverySignature(
  api: Pick<RecoveryApi, 'submitSignature' | 'client'>,
  platform: PlatformSession,
  signer: RecoverySigner,
  verified: VerifiedOperation,
): Promise<OperationStatus> {
  const { operation } = verified;
  const signature = strictSignature(await signSafeTx(signer, operation.chainId, operation.safe, verified.safeTx));
  const recovered = await recoverAddress({ hash: verified.hash, signature });
  if (!isAddressEqual(recovered, signer.address)) {
    throw new RecoverySignatureError('La firma no es de tu clave R: no se envía.');
  }
  const envelope = await signSubmission(
    platform.auth.key,
    { operationId: operation.operationId, safeTxHash: verified.hash, sessionId: platform.auth.sessionId },
    api.client.clock.nowSeconds(),
  );
  return api.submitSignature(platform.auth, operation.operationId, { ownerSignature: signature, ...envelope });
}

export class OperationWaitTimeout extends Error {
  override name = 'OperationWaitTimeout';
}

/** Sigue el estado hasta que la operación queda en la cadena o muere (o vence la espera). */
export async function waitForOperation(
  api: Pick<RecoveryApi, 'operation'>,
  operationId: string,
  options: { timeoutMs?: number; intervalMs?: number; onUpdate?: (status: OperationStatus) => void } = {},
): Promise<OperationStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    const status = await api.operation(operationId);
    options.onUpdate?.(status);
    if (SETTLED_STATES.includes(status.status) || DEAD_STATES.includes(status.status)) return status;
    if (Date.now() > deadline)
      throw new OperationWaitTimeout('La operación sigue en curso: revisá su estado más tarde.');
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 2_000));
  }
}

/** Preparadas sin firmar en esta pestaña: si la verificación falla o el review se cancela, se cancelan (liberan el nonce). */
const unsigned = new Set<string>();

export async function verifiedOrReleased<T>(
  api: Pick<RecoveryApi, 'operation' | 'cancelOperation'>,
  platform: PlatformSession,
  prepared: readonly PreparedOperation[],
  verify: () => T | Promise<T>,
): Promise<T> {
  for (const op of prepared) unsigned.add(op.operationId);
  try {
    return await verify();
  } catch (error) {
    await releasePrepared(
      api,
      platform,
      prepared.map((op) => op.operationId),
    );
    throw error;
  }
}

export function markSigned(operationId: string): void {
  unsigned.delete(operationId);
}

export async function releasePrepared(
  api: Pick<RecoveryApi, 'operation' | 'cancelOperation'>,
  platform: PlatformSession,
  operationIds: readonly string[] = [...unsigned],
): Promise<void> {
  await Promise.all(
    operationIds.map(async (operationId) => {
      unsigned.delete(operationId);
      try {
        if ((await api.operation(operationId)).status === 'CREATED')
          await api.cancelOperation(platform.auth, operationId);
      } catch {
        // Ya venció o se canceló: su nonce está libre.
      }
    }),
  );
}
