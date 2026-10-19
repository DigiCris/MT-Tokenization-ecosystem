// Activar Recovery (P18.T01 en el onboarding y P18.T09.a para reemplazar R): pide el enrollment, muestra el QR (lo
// recomendado: R en otro dispositivo) y el enlace para la app Recovery con el secreto `k` del pedido (ADR-033: sólo en
// la memoria de esta pestaña y en los fragmentos de los enlaces, nunca en un servidor), espera a que Recovery informe la
// dirección de R y la confirma con el enlace de regreso (otra pestaña, por BroadcastChannel: tiene que traer el mismo
// `k`) o con la comparación manual de la dirección completa (sus 10 grupos, copiados de la pantalla de Recovery). La
// dirección que informa el backend no se muestra hasta que coincide: si se mostrara, se la podría copiar de acá y la
// comparación no detectaría una R sustituida ([F-LNK-02]). La comparación manual tiene 3 intentos; si el enlace de
// regreso trae otra R o no trae el `k` del pedido, o se agotan los intentos, ese pedido se aborta (ya no se confirma por
// ningún camino), se le informa al backend para la auditoría y la alerta (N10) y hay que generar uno nuevo, que obliga a
// crear otra R en Recovery. Recién con R confirmada sigue.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { appConfig } from '../config/index.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { describeError } from '../ui/errors.ts';
import {
  ADDRESS_GROUPS,
  BEFORE_NEW_REQUEST_TEXT,
  compareManually,
  confirmWithReturnLink,
  distributePaste,
  MANUAL_ABORT_TEXT,
  MANUAL_MISMATCH_TEXT,
  manualRetryText,
  NEW_REQUEST_TEXT,
  newReturnSecret,
  RecoveryAbortError,
  recoveryEnrollLink,
  reportAbort,
  requestExpiryText,
  ReturnLinkUnverifiedError,
  sameSecret,
  submittedRecoveryKey,
  type RejectReason,
} from './activation.ts';
import { listenForReturn } from './return-channel.ts';

export interface ConfirmedRecovery {
  recoveryKey: Address;
  enrollmentId: string;
  /**
   * Nonce del pedido confirmado (lo compara la creación de la Safe con el de la asignación de S). null sólo si no se lo
   * conoce: un enlace de regreso abierto en una pestaña sin el pedido ya no confirma R (ADR-033), así que hoy no pasa.
   */
  enrollmentNonce: `0x${string}` | null;
}

/** Un pedido vigente con su secreto `k` (generado acá; sólo vive en la memoria de esta pestaña). */
interface Request {
  created: CreatedEnrollment;
  secret: string;
}

const emptyGroups = () => Array.from({ length: ADDRESS_GROUPS }, () => '');

export function RecoveryActivationStep({
  walletId,
  platform,
  onConfirmed,
  intro,
  warning,
}: {
  walletId: string;
  platform: PlatformAuth;
  onConfirmed: (confirmed: ConfirmedRecovery) => void;
  intro: string;
  /** Aviso destacado debajo de la introducción (p. ej. qué pasa si se pierden U y R). */
  warning?: string;
}) {
  const [request, setRequest] = useState<Request | null>(null);
  // Cuántos pedidos se generaron en este paso: desde el segundo, Recovery va a crear otra R.
  const [requests, setRequests] = useState(0);
  const [enrollment, setEnrollment] = useState<RecoveryEnrollment | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [typed, setTyped] = useState<string[]>(emptyGroups);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [mismatch, setMismatch] = useState<{ groups: number[]; attemptsLeft: number } | null>(null);
  const [confirmed, setConfirmed] = useState<Address | null>(null);
  // Pedido abortado: el motivo se muestra y ningún camino (enlace de regreso o comparación manual) lo confirma.
  const [abortReason, setAbortReason] = useState<string | null>(null);
  const aborted = useRef(false);

  const abort = useCallback(
    (enrollmentId: string, message: string, reason: RejectReason) => {
      if (aborted.current) return;
      aborted.current = true;
      setAbortReason(message);
      // Si el backend no lo registra (red, sesión vencida), el aborto local sigue igual.
      void reportAbort(api, platform, enrollmentId, reason);
    },
    [platform],
  );

  const create = useAsyncAction(
    useCallback(async () => {
      // Sin pedido mientras se crea el nuevo: el polling y el enlace de regreso del anterior se cortan (sus respuestas
      // tardías se descartan) y no vuelven a poblar el paso con su R. El secreto del anterior se descarta con él.
      setRequest(null);
      setEnrollment(null);
      aborted.current = false;
      setAbortReason(null);
      setLinkError(null);
      setManualError(null);
      setPollError(null);
      setFailedAttempts(0);
      setMismatch(null);
      setConfirmed(null);
      setTyped(emptyGroups());
      const created = await api.createRecoveryEnrollment(platform, walletId);
      setRequest({ created, secret: newReturnSecret() });
      setRequests((n) => n + 1);
    }, [platform, walletId]),
  );

  // Un enrollment por montaje del paso (uno nuevo reemplaza a los anteriores en el backend).
  const start = create.run;
  useEffect(() => {
    void start();
  }, [start]);

  const created = request?.created ?? null;
  const reported = (() => {
    try {
      return enrollment ? submittedRecoveryKey(enrollment) : null;
    } catch {
      return null;
    }
  })();

  // Espera a que Recovery informe R (o a que el pedido venza). Un pedido abortado ya no se consulta.
  const isAborted = abortReason !== null;
  useEffect(() => {
    if (created === null || reported !== null || isAborted) return undefined;
    let live = true;
    const tick = () => {
      api
        .getRecoveryEnrollment(created.enrollmentId)
        .then((current) => {
          if (!live) return;
          setEnrollment(current);
          submittedRecoveryKey(current);
        })
        .catch((error: unknown) => {
          if (live) setPollError(describeError(error));
        });
    };
    tick();
    const timer = setInterval(tick, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [created, reported, isAborted]);

  const finish = useCallback(
    (recoveryKey: Address) => {
      if (!created || aborted.current) return;
      onConfirmed({ recoveryKey, enrollmentId: created.enrollmentId, enrollmentNonce: created.nonce });
    },
    [created, onConfirmed],
  );

  // Enlace de regreso abierto en otra pestaña (sólo el del pedido vigente: lo que llega tarde de otro se descarta). Sin el
  // `k` de este pedido no lo armó la app Recovery: se aborta sin consultar nada; con el `k`, la R tiene que ser la del
  // backend.
  useEffect(() => {
    if (request === null) return undefined;
    const { created: current, secret } = request;
    const alive = { current: true };
    const stop = listenForReturn(current.enrollmentId, (recoveryKey, linkSecret) => {
      if (!sameSecret(secret, linkSecret)) {
        const error = new ReturnLinkUnverifiedError();
        abort(current.enrollmentId, error.message, error.reason);
        return;
      }
      void api
        .getRecoveryEnrollment(current.enrollmentId)
        .then((latest) => {
          if (!alive.current) return;
          setEnrollment(latest);
          finish(
            confirmWithReturnLink(
              latest,
              { enrollmentId: current.enrollmentId, recoveryKey: recoveryKey as Address, secret: linkSecret },
              secret,
            ),
          );
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          if (error instanceof RecoveryAbortError) abort(current.enrollmentId, error.message, error.reason);
          else setLinkError(describeError(error));
        });
    });
    return () => {
      alive.current = false;
      stop();
    };
  }, [request, finish, abort]);

  const link = request ? recoveryEnrollLink(appConfig.recoveryOrigin, request.created, request.secret) : null;
  const newRequestButton = (
    <button type="button" className="button" onClick={() => void create.run()}>
      Generar un pedido nuevo
    </button>
  );

  return (
    <article className="card stack" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Activar Recovery</h2>
      <p>{intro}</p>
      {warning && <Notice tone="warning">{warning}</Notice>}
      {create.error && (
        <>
          <Notice tone="error">{create.error}</Notice>
          <button type="button" className="button" onClick={() => void create.run()}>
            Reintentar
          </button>
        </>
      )}
      {link && created && reported === null && abortReason === null && (
        <div className="stack">
          {requests > 1 && <Notice tone="warning">{NEW_REQUEST_TEXT}</Notice>}
          <p>
            Te recomendamos crear tu clave R en otro dispositivo, como tu celular: escaneá este QR con su cámara y se
            abre la app Recovery con este pedido. Si no tenés otro dispositivo, abrí el enlace en este.
          </p>
          <QrCanvas text={link} label="QR para abrir la app Recovery con este pedido" />
          <p>
            <a href={link} target="_blank" rel="noopener noreferrer" data-recovery-link={link}>
              Abrir la app Recovery en este dispositivo
            </a>
          </p>
          <p className="muted">
            Los datos del pedido van en la parte del enlace que sigue al «#», y el navegador no la envía a ningún
            servidor. Si mandás el enlace por chat o por email, sí pasa por esos servicios: por eso conviene el QR.
          </p>
          <p data-request-expires={created.expiresAt}>{requestExpiryText(created.expiresAt)}</p>
          <Notice>Esperando que Recovery informe la dirección de tu clave R…</Notice>
          {pollError && <Notice tone="error">{pollError}</Notice>}
          {enrollment?.status === 'EXPIRED' && (
            <div className="stack">
              <p>{BEFORE_NEW_REQUEST_TEXT}</p>
              <button type="button" className="button" onClick={() => void create.run()}>
                El pedido venció: generar uno nuevo
              </button>
            </div>
          )}
        </div>
      )}
      {abortReason !== null && (
        <div className="stack">
          <Notice tone="error">{abortReason}</Notice>
          <p>{BEFORE_NEW_REQUEST_TEXT}</p>
          {newRequestButton}
        </div>
      )}
      {reported !== null && abortReason === null && confirmed !== null && (
        <div className="stack">
          <Notice tone="success">
            Dirección de tu clave R (confirmada): <AddressText address={confirmed} />
          </Notice>
          <button
            type="button"
            className="button"
            onClick={() => {
              finish(confirmed);
            }}
          >
            Continuar
          </button>
        </div>
      )}
      {created && reported !== null && abortReason === null && confirmed === null && (
        <div className="stack">
          <p>
            Recovery ya informó la dirección de tu clave R. Si abriste el enlace de regreso de Recovery, se confirma
            sola.
          </p>
          <p>
            Si no, copiá la dirección que muestra la app Recovery (acá no la mostramos a propósito). Sirve para
            comprobar que nadie la cambió en el camino; da igual mayúsculas o minúsculas. Va en {ADDRESS_GROUPS} grupos
            de 4 caracteres, como la muestra Recovery; si la pegás completa, se reparte sola en los grupos.
          </p>
          {linkError && <Notice tone="error">{linkError}</Notice>}
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!enrollment || aborted.current) return;
              try {
                setManualError(null);
                const attempt = compareManually(enrollment, typed, failedAttempts);
                if (attempt.match) {
                  setMismatch(null);
                  setConfirmed(attempt.recoveryKey);
                  return;
                }
                setFailedAttempts((failed) => failed + 1);
                if (attempt.attemptsLeft === 0) {
                  abort(created.enrollmentId, MANUAL_ABORT_TEXT, 'MANUAL_COMPARISON_FAILED');
                  return;
                }
                setMismatch({ groups: attempt.mismatchedGroups, attemptsLeft: attempt.attemptsLeft });
              } catch (error) {
                setManualError(describeError(error));
              }
            }}
          >
            {typed.map((value, i) => (
              <Field
                key={i}
                label={`Grupo ${String(i + 1)} de ${String(ADDRESS_GROUPS)}`}
                name={`group-${String(i)}`}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={4}
                required
                aria-invalid={mismatch?.groups.includes(i) === true ? true : undefined}
                value={value}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setTyped((current) => current.map((v, j) => (j === i ? next : v)));
                }}
                onPaste={(event) => {
                  const next = distributePaste(typed, i, event.clipboardData.getData('text'));
                  if (next === null) return;
                  event.preventDefault();
                  setTyped(next);
                }}
              />
            ))}
            {mismatch && (
              <div className="stack" data-mismatch-groups={mismatch.groups.map((g) => g + 1).join(',')}>
                <Notice tone="error">{MANUAL_MISMATCH_TEXT}</Notice>
                <p>{manualRetryText(mismatch.groups, mismatch.attemptsLeft)}</p>
                <p>{BEFORE_NEW_REQUEST_TEXT}</p>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    // Dejar este pedido después de una comparación que no coincidió es abortarlo: se informa igual.
                    void reportAbort(api, platform, created.enrollmentId, 'MANUAL_COMPARISON_FAILED');
                    void create.run();
                  }}
                >
                  Generar un pedido nuevo
                </button>
              </div>
            )}
            {manualError && <Notice tone="error">{manualError}</Notice>}
            <button type="submit" className="button">
              Confirmar la dirección de R
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
