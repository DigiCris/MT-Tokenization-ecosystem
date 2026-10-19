// Review, firma y seguimiento de operaciones del camino asistido (P18): muestra lo que hace cada SafeTx decodificada de
// los bytes que armó la app (ya comparados con los del backend), con el destino nombrado, la red y quién paga el gas,
// y los detalles técnicos aparte; pide el segundo factor si la operación lo requiere (umbral de la policy y canal), U
// firma cada una y se sigue su estado hasta que se mina, falla o se cancela, con un cierre claro (éxito o error, link a
// la transacción y cómo seguir). Antes de firmar se puede cancelar: lo preparado se cancela en el backend y su nonce
// queda libre (operations/prepared.ts).
import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { explorerTx } from '../activity/activity.ts';
import type { OperationStatus } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { formatAmount } from '../assets/amount.ts';
import { decodeSafeTx, type DecodeContext, type DecodedCall } from '../chain/decoders.ts';
import type { VerifiedOperation } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import { useSession } from '../session/context.tsx';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import type { UnlockedWallet } from '../unlock/unlock.ts';
import { CallDescription } from './CallDescription.tsx';
import { describeParts, STATE_TEXT, tokenAmount, type ChainClock, type DescriptionPart } from './describe.ts';
import { addressNames, type NameOf } from './names.ts';
import { markSigned, releasePrepared } from './prepared.ts';
import { DEAD_STATES, SETTLED_STATES, signAndSubmit, waitForOperation } from './sign.ts';
import { technicalCall } from './technical.ts';

function TechnicalDetails({
  item,
  decode,
  nameOf,
}: {
  item: VerifiedOperation;
  decode: DecodeContext;
  nameOf: NameOf;
}) {
  const call = technicalCall(item.safeTx, decode);
  return (
    <details className="details">
      <summary>Detalles técnicos</summary>
      <dl className="summary">
        <dt>Contrato que se llama</dt>
        <dd>
          <CallDescription parts={[{ kind: 'address', address: call.to, name: nameOf(call.to) }]} />
        </dd>
        <dt>Valor en ETH</dt>
        <dd>{call.value === 0n ? '0 (no se envía ETH)' : call.value.toString()}</dd>
        <dt>Tipo de llamada</dt>
        <dd>{call.operation === 0 ? 'CALL (llamada común; nunca DELEGATECALL)' : 'DELEGATECALL'}</dd>
        <dt>Función</dt>
        <dd>
          <code>{call.signature ?? (call.data === '0x' ? 'ninguna (sin datos)' : 'no reconocida')}</code>
        </dd>
        {call.args.map((arg) => (
          <Fragment key={arg.name}>
            <dt>
              Argumento <code>{arg.name}</code>
            </dt>
            <dd>
              <code>{arg.value}</code>
            </dd>
          </Fragment>
        ))}
        <dt>Número de orden en tu Safe (nonce)</dt>
        <dd>{call.nonce.toString()}</dd>
        <dt>Hash que firmás (EIP-712)</dt>
        <dd>
          <code data-hash={item.hash}>{item.hash}</code>
        </dd>
      </dl>
    </details>
  );
}

/** Texto del segundo factor: el umbral de la policy (lo informa el backend) y el canal (TOTP si está activo, si no email). */
function twoFactorTexts(
  threshold: string | null | undefined,
  call: DecodedCall | undefined,
  channel: { method: 'TOTP' | 'EMAIL'; email: string | null; requested: boolean },
): [string, DescriptionPart[]] {
  const transfer = call?.kind === 'TRANSFER' ? call : null;
  const known = typeof threshold === 'string' && /^\d+$/.test(threshold) && transfer !== null;
  const why = known
    ? `Los envíos de ${formatAmount(BigInt(threshold), 6, 0)} ${transfer.token} o más necesitan un segundo factor.`
    : 'Esta operación necesita un segundo factor por su monto.';
  const text = (value: string): DescriptionPart => ({ kind: 'text', text: value });
  if (channel.method === 'TOTP')
    return [why, [text('Lo confirmás con el código de 6 dígitos de tu app de autenticación.')]];
  const to = channel.email === null ? '' : ` a ${channel.email}`;
  const intro = text(
    `${channel.requested ? 'Te mandamos' : 'Te vamos a mandar'} un código por email${to}: antes de escribirlo, ` +
      'comprobá que el email muestre ',
  );
  if (!transfer) return [why, [intro, text('el mismo monto y el mismo destino que ves acá.')]];
  return [
    why,
    [
      intro,
      { kind: 'amount', text: tokenAmount(transfer.amount, transfer.token) },
      text(' y el destino '),
      { kind: 'address', address: transfer.recipient, name: null },
      text(', lo mismo que ves acá.'),
    ],
  ];
}

export function OperationReview({
  title,
  doneTitle,
  items,
  unlocked,
  decode,
  labels,
  clock,
  summary,
  onSettled,
  onCancel,
  result,
  doneActions,
  confirmLabel,
}: {
  title: string;
  /** Título cuando todas quedaron en la cadena (p. ej. "Envío realizado"). */
  doneTitle?: string;
  items: VerifiedOperation[];
  unlocked: UnlockedWallet;
  decode: DecodeContext;
  /** Labels de la whitelist por dirección en minúsculas (operations/names.ts): el destino con su nombre. */
  labels?: ReadonlyMap<string, string>;
  /** Hora de la cadena y del dispositivo leídas juntas: vencimientos que decide la cadena (deadline del swap). */
  clock?: ChainClock | null;
  /** Contexto arriba de las operaciones (p. ej. la cotización y el slippage del swap). */
  summary?: ReactNode;
  onSettled?: (statuses: OperationStatus[]) => void;
  /** Después de cancelar en el backend lo preparado (antes de firmar). */
  onCancel: () => void;
  /** Lo que se comprobó al terminar (p. ej. el permiso que quedó después de un swap), dentro del review. */
  result?: ReactNode;
  /** Cómo seguir cuando termina (volver, hacer otra). */
  doneActions?: ReactNode;
  confirmLabel?: string;
}) {
  const { user } = useSession();
  const [twoFactor, setTwoFactor] = useState<{ operationId: string; method: 'TOTP' | 'EMAIL' } | null>(null);
  const [passed, setPassed] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, OperationStatus>>({});
  const [finished, setFinished] = useState<OperationStatus[] | null>(null);
  const nameOf = addressNames({ safe: decode.safe, chain: decode.chain, system: decode.system }, labels);
  const decoded = items.map((item) => decodeSafeTx(item.safeTx, decode));
  const blocked = decoded.some((d) => d.kind === 'UNKNOWN');
  const twoFactorIndex = items.findIndex((item) => item.operation.requiresTwoFactor);
  const needsTwoFactor = items[twoFactorIndex] ?? null;
  const done = items.length > 0 && items.every((item) => statuses[item.operation.operationId] !== undefined);
  const count = items.length;

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
    setFinished(settled);
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

  const success = finished !== null && finished.every((status) => SETTLED_STATES.includes(status.status));
  const dead = finished?.filter((status) => DEAD_STATES.includes(status.status)).length ?? 0;
  const method = twoFactor?.method ?? (user?.totpEnabled === true ? 'TOTP' : 'EMAIL');
  const [why, how] = twoFactorTexts(needsTwoFactor?.operation.twoFactorThreshold, decoded[twoFactorIndex], {
    method,
    email: user?.email ?? null,
    requested: twoFactor !== null,
  });
  const ended = finished !== null || (signedAny && !sign.pending && sign.error !== null);

  return (
    <article className="card stack" aria-labelledby="review-title" data-review={success ? 'done' : 'open'}>
      <h2 id="review-title">{success && doneTitle ? doneTitle : title}</h2>
      {summary}
      <ol className="review">
        {items.map((item, i) => {
          const status = statuses[item.operation.operationId];
          const call: DecodedCall = decoded[i] ?? { kind: 'UNKNOWN', reason: '?' };
          return (
            <li key={item.operation.operationId} className="review__item" data-operation={item.operation.operationType}>
              {count > 1 && (
                <p className="review__step">
                  Operación {i + 1} de {count}
                </p>
              )}
              <p className="review__what">
                <CallDescription
                  parts={describeParts(call, { nameOf, clock: clock ?? null, showDeadline: finished === null })}
                />
              </p>
              <TechnicalDetails item={item} decode={decode} nameOf={nameOf} />
              {status && (
                <p role="status" className="review__status" data-status={status.status}>
                  Estado: {STATE_TEXT[status.status]}
                  {status.failureReason ? ` (${status.failureReason})` : ''}
                  {status.txHash && (
                    <>
                      {' · '}
                      <a
                        className="nowrap"
                        href={explorerTx(pinnedChain, status.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        ver transacción
                      </a>
                    </>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="review__facts muted">
        Red: Base. El gas de la red lo paga la plataforma: no se descuenta de tu saldo.
      </p>
      {blocked && <Notice tone="error">Hay una operación que esta app no reconoce: no se firma.</Notice>}
      {!blocked && needsTwoFactor && !passed && !done && (
        <div className="stack" data-two-factor={method}>
          <Notice tone="warning">
            <p>{why}</p>
            <p>
              <CallDescription parts={how} />
            </p>
          </Notice>
          {twoFactor ? (
            <form
              key="two-factor"
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
                Confirmar el código
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
                {method === 'TOTP' ? 'Ingresar el código de mi app' : 'Pedir el código por email'}
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
            {sign.pending
              ? 'Firmando y enviando…'
              : (confirmLabel ??
                (count > 1 ? `Firmar las ${String(count)} operaciones con tu clave U` : 'Firmar con tu clave U'))}
          </button>
        </>
      )}
      {done && sign.error && <Notice tone="error">{sign.error}</Notice>}
      {signedAny && finished === null && sign.pending && (
        <p className="muted">
          {count > 1
            ? 'Firmadas: la plataforma las co-firma y las envía a la red, en orden. Esperando que se incluyan en un bloque…'
            : 'Firmada: la plataforma la co-firma y la envía a la red. Esperando que se incluya en un bloque…'}
        </p>
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
      {success && (
        <Notice tone="success">
          <p>
            {count > 1
              ? `Listo: las ${String(count)} operaciones ya están incluidas en un bloque de Base.`
              : 'Listo: la operación ya está incluida en un bloque de Base.'}
          </p>
          <p>
            En unos minutos {count > 1 ? 'pasan' : 'pasa'} a Confirmada y, en unos 20 minutos, a Final: desde ahí ya no
            se puede revertir. Podés seguir el estado en <Link to="/activity">Actividad</Link>.
          </p>
        </Notice>
      )}
      {finished !== null && dead === count && (
        <Notice tone="error">
          {count > 1 ? 'Las operaciones no se ejecutaron.' : 'La operación no se ejecutó.'} El motivo está en su estado;
          tus fondos no se movieron.
        </Notice>
      )}
      {finished !== null && dead > 0 && dead < count && (
        <Notice tone="error">
          Alguna de las operaciones no se ejecutó: revisá el estado de cada una acá y en{' '}
          <Link to="/activity">Actividad</Link>.
        </Notice>
      )}
      {finished !== null && result}
      {ended && doneActions && <div className="actions">{doneActions}</div>}
    </article>
  );
}
