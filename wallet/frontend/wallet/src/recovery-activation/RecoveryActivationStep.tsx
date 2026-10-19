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
//
// Revisión de seguridad de ADR-033: ningún texto de la plataforma aparece en este paso (sólo textos locales); con el `k`
// del pedido, cualquier respuesta que no confirme exactamente la R del enlace aborta (sólo un error de red deja
// reintentar), y la pestaña del enlace recibe el resultado real. La comparación manual vuelve a leer el pedido antes de
// aceptarse, y un pedido que la plataforma da por terminado (cancelado o reemplazado desde otra pestaña o dispositivo,
// vencido) ofrece generar otro. Dejar el pedido después de una comparación que no coincidió lo aborta e informa: al
// salir de la pantalla por la cola de avisos y al cerrar o recargar la pestaña con un aviso firmado de antemano.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { ApiError, NetworkError } from '../api/problem.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';
import { abortReports, api } from '../app/services.ts';
import { appConfig } from '../config/index.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import type { EnrollmentPurpose, PendingAbort } from './abort-reports.ts';
import {
  ADDRESS_GROUPS,
  BEFORE_NEW_REQUEST_TEXT,
  compareManually,
  confirmWithReturnLink,
  distributePaste,
  endedRequestText,
  LEFT_AFTER_MISMATCH_TEXT,
  MANUAL_ABORT_TEXT,
  MANUAL_MISMATCH_TEXT,
  manualRetryText,
  NEW_REQUEST_TEXT,
  newReturnSecret,
  POLL_ERROR_TEXT,
  RecoveryAbortError,
  recoveryEnrollLink,
  RecoveryKeyMismatchError,
  requestExpiryText,
  RETURN_LINK_NETWORK_TEXT,
  ReturnLinkUnverifiedError,
  sameSecret,
  submittedRecoveryKey,
  type RejectReason,
} from './activation.ts';
import { listenForReturn, type ReturnResult } from './return-channel.ts';

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
const NOT_FOUND_TEXT = 'La plataforma ya no encuentra este pedido.';
/** La respuesta es de ese pedido (una de otro no se usa). */
const sameRequest = (enrollment: RecoveryEnrollment, enrollmentId: string) =>
  enrollment.id.toLowerCase() === enrollmentId.toLowerCase();

export function RecoveryActivationStep({
  walletId,
  platform,
  sessionExpiresAt,
  onConfirmed,
  intro,
  warning,
}: {
  walletId: string;
  platform: PlatformAuth;
  /** Cuándo vence la PlatformSession (para reintentar los avisos de aborto mientras siga vigente). */
  sessionExpiresAt?: string;
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
  const [checking, setChecking] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [mismatch, setMismatch] = useState<{ groups: number[]; attemptsLeft: number } | null>(null);
  const [confirmed, setConfirmed] = useState<Address | null>(null);
  // Pedido terminado: abortado acá (e informado) o dado por terminado por la plataforma. Se muestra el motivo y ningún
  // camino (enlace de regreso o comparación manual) lo confirma.
  const [ended, setEnded] = useState<string | null>(null);
  // El pedido vigente y los terminados, por id: un resultado tardío de otro pedido o de uno terminado no confirma nada.
  const current = useRef<string | null>(null);
  const endedIds = useRef(new Set<string>());
  // Pedidos ya confirmados: el mismo enlace abierto otra vez no vuelve a confirmar (ni cancela) nada.
  const doneIds = useRef(new Set<string>());
  // El callback y la sesión vigentes, sin volver a suscribir el canal del enlace en cada render del padre.
  const onConfirmedRef = useRef(onConfirmed);
  const sessionRef = useRef({ platform, expiresAt: sessionExpiresAt });
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
    sessionRef.current = { platform, expiresAt: sessionExpiresAt };
  });

  const report = useCallback((abort: PendingAbort) => {
    const { platform: auth, expiresAt } = sessionRef.current;
    void abortReports.report(abort, {
      platform: auth,
      purpose: abort.purpose ?? 'ONBOARDING',
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }, []);

  /** Aborta el pedido acá y se lo informa al backend (si no llega ahora, queda en la cola para la próxima sesión). */
  const abort = useCallback(
    (enrollmentId: string, purpose: EnrollmentPurpose, message: string, reason: RejectReason) => {
      if (endedIds.current.has(enrollmentId)) return;
      endedIds.current.add(enrollmentId);
      if (current.current === enrollmentId) setEnded(message);
      report({ enrollmentId, reason, purpose });
    },
    [report],
  );

  /** La plataforma da el pedido por terminado: no se informa nada, sólo se ofrece generar otro. */
  const end = useCallback((enrollmentId: string, message: string) => {
    endedIds.current.add(enrollmentId);
    if (current.current === enrollmentId) setEnded(message);
  }, []);

  const finish = useCallback((created: CreatedEnrollment, recoveryKey: Address) => {
    if (endedIds.current.has(created.enrollmentId) || current.current !== created.enrollmentId) return false;
    doneIds.current.add(created.enrollmentId);
    onConfirmedRef.current({ recoveryKey, enrollmentId: created.enrollmentId, enrollmentNonce: created.nonce });
    return true;
  }, []);

  const create = useAsyncAction(
    useCallback(async () => {
      // Sin pedido mientras se crea el nuevo: el polling y el enlace de regreso del anterior se cortan (sus respuestas
      // tardías se descartan) y no vuelven a poblar el paso con su R. El secreto del anterior se descarta con él.
      current.current = null;
      setRequest(null);
      setEnrollment(null);
      setEnded(null);
      setLinkError(null);
      setManualError(null);
      setPollError(null);
      setFailedAttempts(0);
      setMismatch(null);
      setConfirmed(null);
      setTyped(emptyGroups());
      const created = await api.createRecoveryEnrollment(platform, walletId);
      // Recién con el pedido nuevo puesto pasa a ser el vigente: nada tardío del anterior cae en éste.
      current.current = created.enrollmentId;
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
  const waiting = reported === null;

  // Estado del pedido: hasta que Recovery informe R, cada 3 s; después, cada 10 s, para enterarse si otra pestaña u
  // otro dispositivo lo canceló o lo reemplazó. Ningún texto de la plataforma se muestra.
  useEffect(() => {
    if (created === null || ended !== null || confirmed !== null) return undefined;
    let live = true;
    const tick = () => {
      api
        .getRecoveryEnrollment(created.enrollmentId)
        .then((latest) => {
          if (!live) return;
          // Una respuesta de otro pedido no se usa (la plataforma respondió mal): se sigue preguntando.
          if (!sameRequest(latest, created.enrollmentId)) {
            setPollError(POLL_ERROR_TEXT);
            return;
          }
          setPollError(null);
          const over = endedRequestText(latest);
          if (over !== null) end(created.enrollmentId, over);
          else setEnrollment(latest);
        })
        .catch((error: unknown) => {
          if (!live) return;
          if (error instanceof ApiError && error.status === 404) end(created.enrollmentId, NOT_FOUND_TEXT);
          else setPollError(POLL_ERROR_TEXT);
        });
    };
    tick();
    const timer = setInterval(tick, waiting ? 3_000 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [created, ended, confirmed, waiting, end]);

  // Enlace de regreso abierto en otra pestaña (sólo el del pedido vigente). Sin el `k` de este pedido no lo armó la app
  // Recovery: se aborta sin consultar nada. Con el `k`, sólo confirma que la plataforma informe este mismo pedido
  // SUBMITTED con esa R; cualquier otra respuesta aborta, y sólo un error de red deja reintentar. A la pestaña del enlace
  // le llega el resultado real.
  useEffect(() => {
    if (request === null) return undefined;
    const { created: pending, secret } = request;
    const id = pending.enrollmentId;
    return listenForReturn(id, async (recoveryKey, linkSecret): Promise<ReturnResult> => {
      if (doneIds.current.has(id)) return 'confirmed';
      if (endedIds.current.has(id) || current.current !== id) return 'aborted';
      if (!sameSecret(secret, linkSecret)) {
        const unverified = new ReturnLinkUnverifiedError();
        abort(id, pending.purpose, unverified.message, unverified.reason);
        return 'aborted';
      }
      const mismatched = () => {
        const error = new RecoveryKeyMismatchError();
        abort(id, pending.purpose, error.message, error.reason);
        return 'aborted' as const;
      };
      if (!isAddress(recoveryKey)) return mismatched();
      let latest: RecoveryEnrollment;
      try {
        latest = await api.getRecoveryEnrollment(id);
      } catch (error) {
        if (!(error instanceof NetworkError)) return mismatched();
        if (current.current === id) setLinkError(RETURN_LINK_NETWORK_TEXT);
        return 'retry';
      }
      if (endedIds.current.has(id) || current.current !== id) return 'aborted';
      try {
        const confirmedKey = confirmWithReturnLink(
          latest,
          { enrollmentId: id, recoveryKey, secret: linkSecret },
          secret,
        );
        setLinkError(null);
        setEnrollment(latest);
        return finish(pending, confirmedKey) ? 'confirmed' : 'aborted';
      } catch (error) {
        if (error instanceof RecoveryAbortError) {
          abort(id, pending.purpose, error.message, error.reason);
          return 'aborted';
        }
        return mismatched();
      }
    });
  }, [request, abort, finish]);

  // Con una comparación que no coincidió, dejar el pedido lo aborta (ADR-033). Al cerrar o recargar la pestaña sale el
  // aviso firmado de antemano (keepalive); al salir del paso (otra pantalla, sesión vencida), por la cola de avisos.
  const leaving = useRef<PendingAbort | null>(null);
  useEffect(() => {
    if (created === null || mismatch === null || confirmed !== null || ended !== null) {
      leaving.current = null;
      return undefined;
    }
    const entry: PendingAbort = {
      enrollmentId: created.enrollmentId,
      reason: 'MANUAL_COMPARISON_FAILED',
      purpose: created.purpose,
    };
    leaving.current = entry;
    const { platform: auth, expiresAt } = sessionRef.current;
    return abortReports.armOnLeave(
      entry,
      { platform: auth, purpose: created.purpose, ...(expiresAt === undefined ? {} : { expiresAt }) },
      () => {
        // Si la pestaña vuelve del bfcache, el pedido ya quedó abortado e informado.
        leaving.current = null;
        endedIds.current.add(created.enrollmentId);
        if (current.current === created.enrollmentId) setEnded(LEFT_AFTER_MISMATCH_TEXT);
      },
    );
  }, [created, mismatch, confirmed, ended]);
  useEffect(
    () => () => {
      const entry = leaving.current;
      if (entry !== null) report(entry);
    },
    [report],
  );

  const compare = async () => {
    if (created === null) return;
    const id = created.enrollmentId;
    if (endedIds.current.has(id)) return;
    setManualError(null);
    setChecking(true);
    // La vista vigente del pedido, no la del último polling: otra pestaña o dispositivo lo pudo cancelar o reemplazar.
    let latest: RecoveryEnrollment;
    try {
      latest = await api.getRecoveryEnrollment(id);
    } catch (error) {
      setChecking(false);
      if (current.current !== id) return;
      if (error instanceof ApiError && error.status === 404) end(id, NOT_FOUND_TEXT);
      else setManualError('No se pudo consultar el pedido a la plataforma: revisá tu conexión y volvé a confirmar.');
      return;
    }
    setChecking(false);
    if (current.current !== id || endedIds.current.has(id)) return;
    if (!sameRequest(latest, id)) {
      setManualError('La plataforma no respondió bien: volvé a confirmar en un momento.');
      return;
    }
    const over = endedRequestText(latest);
    if (over !== null) {
      end(id, over);
      return;
    }
    setEnrollment(latest);
    try {
      const attempt = compareManually(latest, typed, failedAttempts);
      if (attempt.match) {
        setMismatch(null);
        setConfirmed(attempt.recoveryKey);
        return;
      }
      setFailedAttempts((failed) => failed + 1);
      if (attempt.attemptsLeft === 0) {
        abort(id, created.purpose, MANUAL_ABORT_TEXT, 'MANUAL_COMPARISON_FAILED');
        return;
      }
      setMismatch({ groups: attempt.mismatchedGroups, attemptsLeft: attempt.attemptsLeft });
    } catch (error) {
      // Sólo errores de esta app (p. ej. «todavía no informó»): ningún texto de la plataforma.
      setManualError(describeError(error));
    }
  };

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
      {link && created && reported === null && ended === null && (
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
        </div>
      )}
      {ended !== null && (
        <div className="stack" data-request-ended="">
          <Notice tone="error">{ended}</Notice>
          <p>{BEFORE_NEW_REQUEST_TEXT}</p>
          {newRequestButton}
        </div>
      )}
      {reported !== null && ended === null && confirmed !== null && created && (
        <div className="stack">
          <Notice tone="success">
            Dirección de tu clave R (confirmada): <AddressText address={confirmed} />
          </Notice>
          <button
            type="button"
            className="button"
            onClick={() => {
              finish(created, confirmed);
            }}
          >
            Continuar
          </button>
        </div>
      )}
      {created && reported !== null && ended === null && confirmed === null && (
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
              if (!checking) void compare();
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
                    abort(created.enrollmentId, created.purpose, MANUAL_ABORT_TEXT, 'MANUAL_COMPARISON_FAILED');
                    void create.run();
                  }}
                >
                  Generar un pedido nuevo
                </button>
              </div>
            )}
            {manualError && <Notice tone="error">{manualError}</Notice>}
            <button type="submit" className="button" disabled={checking} aria-busy={checking}>
              Confirmar la dirección de R
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
