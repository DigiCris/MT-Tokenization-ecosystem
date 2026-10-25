// Review y firma de operaciones con R (P19): lo que hace cada SafeTx decodificado de los bytes que armó la app (ya
// comparados con los del backend); R firma cada una y se sigue su estado hasta que se mina, falla o se cancela. Antes
// de firmar se puede cancelar: lo preparado se cancela en el backend y su nonce queda libre. El estado y su motivo van
// con textos de esta app (status.ts), nunca con lo que escriba el backend.
import { useState } from 'react';
import type { OperationStatus } from '../api/recovery-api.ts';
import { api, pinned } from '../app/services.ts';
import type { VerifiedOperation } from '../chain/safe-tx.ts';
import type { PlatformSession } from '../session/store.ts';
import type { RecoverySigner } from '../signer/recovery-signer.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { decodeSafeTx } from './decode.ts';
import { DEAD_STATES, markSigned, releasePrepared, submitRecoverySignature, waitForOperation } from './sign.ts';
import { operationReasonText, stateText } from './status.ts';

export function OperationReview({
  title,
  items,
  platform,
  signer,
  onSettled,
  onCancel,
}: {
  title: string;
  items: VerifiedOperation[];
  platform: PlatformSession;
  signer: RecoverySigner;
  onSettled?: (statuses: OperationStatus[]) => void;
  onCancel: () => void;
}) {
  const [statuses, setStatuses] = useState<Record<string, OperationStatus>>({});
  const [signedAny, setSignedAny] = useState(false);
  const decoded = items.map((item) => decodeSafeTx(item.safeTx, { safe: item.operation.safe, ...pinned }));
  const blocked = decoded.some((d) => !d.known);
  const done = items.length > 0 && items.every((item) => statuses[item.operation.operationId] !== undefined);

  const sign = useAsyncAction(async () => {
    for (const item of items) {
      await submitRecoverySignature(api, platform, signer, item);
      markSigned(item.operation.operationId);
      setSignedAny(true);
    }
    const settled: OperationStatus[] = [];
    for (const item of items) {
      settled.push(
        await waitForOperation(api, item.operation.operationId, {
          onUpdate: (status) => {
            setStatuses((current) => ({ ...current, [status.id]: status }));
          },
        }),
      );
    }
    onSettled?.(settled);
  });
  const cancel = useAsyncAction(async () => {
    await releasePrepared(
      api,
      platform,
      items.map((item) => item.operation.operationId),
    );
    onCancel();
  });

  return (
    <article className="card stack" aria-labelledby="review-title">
      <h2 id="review-title">{title}</h2>
      <ol className="review">
        {items.map((item, i) => {
          const status = statuses[item.operation.operationId];
          return (
            <li key={item.operation.operationId} className="review__item" data-operation={item.operation.operationType}>
              <p className="review__what">{decoded[i]?.text}</p>
              <p className="muted">
                Nonce {item.safeTx.nonce.toString()} · hash <code>{item.hash.slice(0, 18)}…</code>
              </p>
              {status && (
                <p role="status" className="review__status" data-status={status.status}>
                  Estado: {stateText(status.status)}
                  {status.failureReason ? ` (${operationReasonText(status.failureReason)})` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {blocked && <Notice tone="error">Hay una operación que esta app no reconoce: no se firma.</Notice>}
      {sign.error && <Notice tone="error">{sign.error}</Notice>}
      {!blocked && !done && !signedAny && (
        <div className="actions">
          <button type="button" className="button" disabled={sign.pending} onClick={() => void sign.run()}>
            {sign.pending
              ? 'Firmando y enviando…'
              : signer.kind === 'internal'
                ? 'Firmar con tu clave R'
                : 'Firmar con tu wallet'}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={sign.pending || cancel.pending}
            onClick={() => void cancel.run()}
          >
            Cancelar
          </button>
        </div>
      )}
      {done &&
        items.every((item) => DEAD_STATES.includes(statuses[item.operation.operationId]?.status ?? 'CREATED')) && (
          <Notice tone="error">La operación no se ejecutó.</Notice>
        )}
    </article>
  );
}
