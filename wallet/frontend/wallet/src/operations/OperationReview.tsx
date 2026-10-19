// Review, firma y seguimiento de operaciones del camino asistido (P18): muestra lo que hace cada SafeTx decodificada de
// los bytes que armó la app (ya comparados con los del backend), pide el segundo factor si la operación lo requiere,
// U firma cada una y se sigue su estado hasta que se mina, falla o se cancela. Antes de firmar se puede cancelar: lo
// preparado se cancela en el backend y su nonce queda libre (operations/prepared.ts).
import { useState } from 'react';
import type { OperationStatus } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { decodeSafeTx, type DecodeContext } from '../chain/decoders.ts';
import type { VerifiedOperation } from '../chain/safe-tx.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import type { UnlockedWallet } from '../unlock/unlock.ts';
import { describeCall, STATE_TEXT } from './describe.ts';
import { markSigned, releasePrepared } from './prepared.ts';
import { DEAD_STATES, signAndSubmit, waitForOperation } from './sign.ts';

export function OperationReview({
  title,
  items,
  unlocked,
  decode,
  onSettled,
  onCancel,
  confirmLabel = 'Firmar con tu clave U',
}: {
  title: string;
  items: VerifiedOperation[];
  unlocked: UnlockedWallet;
  decode: DecodeContext;
  onSettled?: (statuses: OperationStatus[]) => void;
  /** Después de cancelar en el backend lo preparado (antes de firmar). */
  onCancel: () => void;
  confirmLabel?: string;
}) {
  const [twoFactor, setTwoFactor] = useState<{ operationId: string; method: 'TOTP' | 'EMAIL' } | null>(null);
  const [passed, setPassed] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, OperationStatus>>({});
  const decoded = items.map((item) => decodeSafeTx(item.safeTx, decode));
  const blocked = decoded.some((d) => d.kind === 'UNKNOWN');
  const needsTwoFactor = items.find((item) => item.operation.requiresTwoFactor) ?? null;
  const done = items.length > 0 && items.every((item) => statuses[item.operation.operationId] !== undefined);

  const requestCode = useAsyncAction(async () => {
    if (!needsTwoFactor) return;
    const challenge = await api.requestOperationTwoFactor(unlocked.platform, needsTwoFactor.operation.operationId);
    setTwoFactor({ operationId: needsTwoFactor.operation.operationId, method: challenge.method });
  });
  const confirmCode = useAsyncAction(async (code: string) => {
    if (!twoFactor) return;
    await api.confirmOperationTwoFactor(unlocked.platform, twoFactor.operationId, code);
    setPassed(true);
  });
  const [signedAny, setSignedAny] = useState(false);
  const sign = useAsyncAction(async () => {
    const settled: OperationStatus[] = [];
    for (const item of items) {
      await signAndSubmit(api, unlocked, item);
      markSigned(item.operation.operationId);
      setSignedAny(true);
    }
    for (const item of items) {
      const final = await waitForOperation(api, item.operation.operationId, {
        onUpdate: (status) => {
          setStatuses((current) => ({ ...current, [status.id]: status }));
        },
      });
      settled.push(final);
    }
    onSettled?.(settled);
  });
  const cancel = useAsyncAction(async () => {
    await releasePrepared(
      api,
      unlocked.platform,
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
              <p className="review__what">{describeCall(decoded[i] ?? { kind: 'UNKNOWN', reason: '?' })}</p>
              <p className="muted">
                Nonce {item.safeTx.nonce.toString()} · hash <code>{item.hash.slice(0, 18)}…</code>
              </p>
              {status && (
                <p role="status" className="review__status" data-status={status.status}>
                  Estado: {STATE_TEXT[status.status]}
                  {status.failureReason ? ` (${status.failureReason})` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {blocked && <Notice tone="error">Hay una operación que esta app no reconoce: no se firma.</Notice>}
      {!blocked && needsTwoFactor && !passed && !done && (
        <div className="stack">
          <Notice tone="warning">Esta operación supera el monto que requiere un segundo factor.</Notice>
          {twoFactor ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmCode.run(formValue(event.currentTarget, 'code').trim());
              }}
            >
              <Field
                label={
                  twoFactor.method === 'TOTP' ? 'Código de tu app de autenticación' : 'Código que te mandamos por email'
                }
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
              {confirmCode.error && <Notice tone="error">{confirmCode.error}</Notice>}
              <button type="submit" className="button" disabled={confirmCode.pending} aria-busy={confirmCode.pending}>
                Confirmar código
              </button>
            </form>
          ) : (
            <>
              {requestCode.error && <Notice tone="error">{requestCode.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={requestCode.pending}
                aria-busy={requestCode.pending}
                onClick={() => void requestCode.run()}
              >
                Pedir el código
              </button>
            </>
          )}
        </div>
      )}
      {!blocked && (!needsTwoFactor || passed) && !done && (
        <>
          {sign.error && <Notice tone="error">{sign.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={sign.pending}
            aria-busy={sign.pending}
            onClick={() => void sign.run()}
          >
            {sign.pending ? 'Firmando y enviando…' : confirmLabel}
          </button>
        </>
      )}
      {!sign.pending && !signedAny && !done && (
        <button
          type="button"
          className="button button--ghost"
          disabled={cancel.pending}
          aria-busy={cancel.pending}
          onClick={() => void cancel.run()}
        >
          {cancel.pending ? 'Cancelando…' : 'Cancelar'}
        </button>
      )}
      {done &&
        items.every((item) => DEAD_STATES.includes(statuses[item.operation.operationId]?.status ?? 'CREATED')) && (
          <Notice tone="error">La operación no se ejecutó.</Notice>
        )}
    </article>
  );
}
