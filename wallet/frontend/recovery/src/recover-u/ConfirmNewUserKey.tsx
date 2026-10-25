// Comparación de U′ antes de firmar la propuesta del reemplazo de U (compare.ts, [F-LNK-04]): la U′ que informa el
// backend no se muestra hasta que coincide con la que el usuario copia de la app Wallet. Los 10 grupos con el 0x fijo
// antes del primero (un 0x tipeado o pegado se ignora), pegar la dirección completa la reparte en los grupos, y antes
// de aceptar se vuelve a leer el borrador (la Wallet pudo registrar otra U′). Con los intentos agotados, el borrador
// queda bloqueado en esta pestaña con el motivo y qué hacer.
import { useState } from 'react';
import { Notice } from '../ui/forms.tsx';
import {
  ADDRESS_GROUPS,
  attemptsLeft,
  BLOCKED_TEXT,
  cleanGroup,
  compareNewKey,
  emptyGroups,
  MISMATCH_TEXT,
  pasteIntoGroups,
  REREAD_ERROR_TEXT,
  retryText,
  sameDraft,
  type UserKeyDraft,
} from './compare.ts';

export function ConfirmNewUserKey({
  draft,
  reread,
  onConfirmed,
}: {
  draft: UserKeyDraft;
  /** El borrador vigente según la plataforma (null si ya no hay): se relee antes de aceptar la comparación. */
  reread: () => Promise<UserKeyDraft | null>;
  onConfirmed: (confirmed: UserKeyDraft) => void;
}) {
  const [typed, setTyped] = useState<string[]>(emptyGroups);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<{ draft: UserKeyDraft; groups: number[]; left: number } | null>(null);

  if (attemptsLeft(draft) === 0) {
    return (
      <div className="stack" data-u-blocked="">
        <Notice tone="error">{BLOCKED_TEXT}</Notice>
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
        Copiá la dirección completa de la clave U nueva que muestra la app Wallet en «Perdí mi Password U»: son{' '}
        {ADDRESS_GROUPS} grupos de 4 caracteres después del «0x», que acá ya está puesto. Acá no la mostramos a
        propósito: así se comprueba que nadie la cambió en el camino. Da igual mayúsculas o minúsculas, y si pegás la
        dirección completa se reparte sola en los grupos.
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
