// Comparación de U′ antes de firmar la propuesta del reemplazo de U (compare.ts, [F-LNK-04]): la U′ que informa el
// backend no se muestra hasta que coincide con la que el usuario copia de la app Wallet, de la pantalla final de «Perdí
// mi Password U» y nunca de un aviso, un email o un chat (ESC-41: ahí puede estar la U″ de un backend comprometido).
// Los 10 grupos con el 0x fijo antes del primero (un 0x tipeado o pegado se ignora), pegar la dirección completa la
// reparte en los grupos, y antes de aceptar se vuelve a leer el borrador (la Wallet pudo registrar otra U′). Con los
// intentos agotados, el borrador queda bloqueado con el motivo y qué hacer, y la app le avisa a la plataforma para que
// lo cancele (si el aviso no llega, el bloqueo sigue y se puede reintentar). Un borrador que la plataforma ya canceló se
// muestra bloqueado de entrada, sin formulario. Ningún texto del backend llega a la pantalla.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { describeError } from '../ui/errors.ts';
import { Notice } from '../ui/forms.tsx';
import {
  ADDRESS_GROUPS,
  attemptsLeft,
  BLOCKED_TEXT,
  cleanGroup,
  compareNewKey,
  draftKey,
  emptyGroups,
  MISMATCH_TEXT,
  pasteIntoGroups,
  rejectedText,
  REPORT_CHANGED_TEXT,
  REPORT_FAILED_TEXT,
  REPORT_UNCONFIRMED_TEXT,
  REPORTED_TEXT,
  REPORTING_TEXT,
  REREAD_ERROR_TEXT,
  retryText,
  sameDraft,
  STILL_BLOCKED_TEXT,
  type CurrentDraft,
  type UserKeyDraft,
} from './compare.ts';

/** La respuesta al aviso a la plataforma de un borrador bloqueado en esta pestaña (sin respuesta: se está avisando). */
type Report = { draft: UserKeyDraft; state: 'done' } | { draft: UserKeyDraft; state: 'failed'; text: string };

/** Por qué no llegó el aviso, con textos de esta app: por el código del backend o, sin respuesta, la red. */
function reportFailure(error: unknown): string {
  const why = error instanceof ApiError ? describeError(error) : 'Revisá tu conexión.';
  return `${REPORT_FAILED_TEXT} ${why} ${STILL_BLOCKED_TEXT}`;
}

export function ConfirmNewUserKey({
  draft,
  rejection,
  reread,
  report,
  onConfirmed,
}: {
  draft: UserKeyDraft;
  /** Si la plataforma ya canceló este borrador (REJECTED), por qué; null si sigue en borrador. */
  rejection: CurrentDraft['rejection'];
  /** El borrador vigente según la plataforma (null si ya no hay): se relee antes de aceptar la comparación. */
  reread: () => Promise<UserKeyDraft | null>;
  /**
   * Avisa a la plataforma que la U′ de este borrador no coincidió: true si lo canceló (la pantalla pasa a recibir el
   * borrador rechazado), false si el pedido cambió (otra U′ en el mismo borrador, o ya no es un borrador).
   */
  report: (draft: UserKeyDraft) => Promise<boolean>;
  onConfirmed: (confirmed: UserKeyDraft) => void;
}) {
  const [typed, setTyped] = useState<string[]>(emptyGroups);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<{ draft: UserKeyDraft; groups: number[]; left: number } | null>(null);
  const [notice, setNotice] = useState<Report | null>(null);
  // Los borradores ya avisados en esta pantalla: el aviso automático sale una vez; después, sólo el reintento.
  const reported = useRef(new Set<string>());
  const blockedHere = attemptsLeft(draft) === 0;

  const send = useCallback(
    async (target: UserKeyDraft) => {
      let outcome: Report;
      try {
        outcome = (await report(target))
          ? { draft: target, state: 'done' }
          : { draft: target, state: 'failed', text: REPORT_CHANGED_TEXT };
      } catch (caught) {
        outcome = { draft: target, state: 'failed', text: reportFailure(caught) };
      }
      setNotice(outcome);
    },
    [report],
  );

  // Con los intentos agotados en esta pestaña y el borrador todavía sin cancelar en la plataforma, se avisa.
  useEffect(() => {
    const key = draftKey(draft);
    if (!blockedHere || rejection !== null || reported.current.has(key)) return;
    reported.current.add(key);
    void send(draft);
  }, [blockedHere, rejection, draft, send]);

  if (blockedHere || rejection !== null) {
    const current = notice !== null && sameDraft(notice.draft, draft) ? notice : null;
    return (
      <div className="stack">
        <div data-u-blocked="">
          <Notice tone="error">{blockedHere ? BLOCKED_TEXT : rejectedText(rejection?.reason ?? null)}</Notice>
        </div>
        {rejection !== null ? (
          <p data-u-report="reported">{REPORTED_TEXT}</p>
        ) : current === null ? (
          <p data-u-report="sending" role="status">
            {REPORTING_TEXT}
          </p>
        ) : (
          // Sin respuesta, con un error o sin que la plataforma confirme la cancelación: el bloqueo de esta pestaña
          // sigue igual y el usuario puede reintentar el aviso.
          <div className="stack" data-u-report="failed">
            <Notice tone="warning">{current.state === 'failed' ? current.text : REPORT_UNCONFIRMED_TEXT}</Notice>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setNotice(null);
                void send(draft);
              }}
            >
              Reintentar el aviso a la plataforma
            </button>
          </div>
        )}
      </div>
    );
  }
  // Un resultado de otro borrador (la Wallet registró otra U′ mientras tanto) no se muestra.
  const shown = mismatch !== null && sameDraft(mismatch.draft, draft) ? mismatch : null;

  const compare = async () => {
    setError(null);
    setChecking(true);
    let latest: UserKeyDraft | null;
    try {
      latest = await reread();
    } catch {
      // Sólo un texto de esta app: el intento no cuenta.
      setError(REREAD_ERROR_TEXT);
      return;
    } finally {
      setChecking(false);
    }
    // Sin borrador, la pantalla ya muestra que no hay un reemplazo pendiente.
    if (latest === null) return;
    const attempt = compareNewKey(latest, typed);
    if (attempt.match) {
      onConfirmed({ id: latest.id, newKey: attempt.newKey });
      return;
    }
    setMismatch({ draft: latest, groups: attempt.mismatchedGroups, left: attempt.attemptsLeft });
  };

  return (
    <div className="stack">
      <p>
        La app Wallet registró una clave U nueva para reemplazar la tuya. Antes de firmar, confirmá que es la que
        creaste vos.
      </p>
      <p>
        Copiá la dirección completa de la clave U nueva que muestra la app Wallet en la pantalla final de «Perdí mi
        Password U» (no la de un aviso, un email o un chat): son {ADDRESS_GROUPS} grupos de 4 caracteres después del
        «0x», que acá ya está puesto. Acá no la mostramos a propósito: así se comprueba que nadie la cambió en el
        camino. Da igual mayúsculas o minúsculas, y si pegás la dirección completa se reparte sola en los grupos.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!checking) void compare();
        }}
      >
        <div className="address-groups">
          {typed.map((value, i) => (
            <div key={i} className="field">
              <label htmlFor={`field-u-group-${String(i)}`} className="field__label">
                {`Grupo ${String(i + 1)} de ${String(ADDRESS_GROUPS)}`}
              </label>
              <div className="address-group">
                {i === 0 && (
                  <span className="address-group__prefix" aria-hidden="true">
                    0x
                  </span>
                )}
                <input
                  id={`field-u-group-${String(i)}`}
                  name={`u-group-${String(i)}`}
                  className="field__input address-group__input"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={4}
                  required
                  aria-invalid={shown?.groups.includes(i) === true ? true : undefined}
                  value={value}
                  onChange={(event) => {
                    const next = cleanGroup(event.currentTarget.value);
                    setTyped((current) => current.map((v, j) => (j === i ? next : v)));
                  }}
                  onPaste={(event) => {
                    const input = event.currentTarget;
                    const next = pasteIntoGroups(typed, i, event.clipboardData.getData('text'), {
                      start: input.selectionStart ?? 0,
                      end: input.selectionEnd ?? input.value.length,
                    });
                    if (next === null) return;
                    event.preventDefault();
                    setTyped(next);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        {shown && (
          <div className="stack" data-mismatch-groups={shown.groups.map((g) => g + 1).join(',')}>
            <Notice tone="error">{MISMATCH_TEXT}</Notice>
            <p>{retryText(shown.groups, shown.left)}</p>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="button" disabled={checking} aria-busy={checking}>
          Confirmar la dirección de la clave U nueva
        </button>
      </form>
    </div>
  );
}
