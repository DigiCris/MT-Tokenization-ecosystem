// Password R nueva ([F-KEY-02]): la app genera 5 palabras, el usuario las anota y confirma 2 al azar (posiciones nuevas
// cada vez que pasa a confirmar; si se equivoca, puede volver a verlas). La usan la creación de R (P19.T03) y el
// re-cifrado de R restaurada desde las 17 palabras (P19.T08). La confirmación es el paso donde se cifra R: quien la usa
// puede sumar ahí sus opciones (la creación de R, recordar el sobre en este dispositivo).
import { useCallback, useState, type ReactNode } from 'react';
import { confirmationPositions, confirmsPassword, newPasswordR } from '../crypto/password.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { Words } from '../ui/Words.tsx';

export function NewPasswordR({
  pending,
  error,
  generateLabel,
  confirmLabel,
  confirmOptions,
  onConfirmed,
}: {
  pending: boolean;
  error: string | null;
  generateLabel: string;
  confirmLabel: string;
  /** Opciones del cifrado, junto al botón que cifra. */
  confirmOptions?: ReactNode;
  onConfirmed: (words: string[]) => void;
}) {
  const [words, setWords] = useState<string[] | null>(null);
  const [step, setStep] = useState<'write' | 'confirm'>('write');
  const [noted, setNoted] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const start = useAsyncAction(
    useCallback(async () => {
      setWords(newPasswordR(await loadWordlist()));
    }, []),
  );

  if (words === null) {
    return (
      <div className="stack">
        {start.error && <Notice tone="error">{start.error}</Notice>}
        <button type="button" className="button" disabled={start.pending} onClick={() => void start.run()}>
          {generateLabel}
        </button>
      </div>
    );
  }

  if (step === 'write') {
    return (
      <section className="stack" aria-labelledby="password-r-title">
        <h3 id="password-r-title">Tu Password R</h3>
        <Notice tone="warning">
          Anotá estas 5 palabras en papel, en este orden. Están en inglés: copialas letra por letra, sin traducir ni
          corregir. Son la Password R: sin ellas no vas a poder abrir el sobre cifrado de R (el archivo y el QR). MT
          Wallet no las guarda ni puede recuperarlas, y no son la contraseña de tu cuenta ni tu Password U.
        </Notice>
        <Words words={words} label="Password R" />
        <label className="check">
          <input
            type="checkbox"
            checked={noted}
            onChange={(event) => {
              setNoted(event.currentTarget.checked);
            }}
          />{' '}
          Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.
        </label>
        <button
          type="button"
          className="button"
          disabled={!noted}
          onClick={() => {
            setPositions(confirmationPositions());
            setTyped({});
            setConfirmError(null);
            setStep('confirm');
          }}
        >
          Ya las anoté
        </button>
      </section>
    );
  }

  return (
    <section className="stack" aria-labelledby="confirm-r-title">
      <h3 id="confirm-r-title">Confirmá tu Password R</h3>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmsPassword(words, typed, positions)) {
            setConfirmError('Las palabras no coinciden: revisá lo que anotaste.');
            return;
          }
          setConfirmError(null);
          onConfirmed(words);
        }}
      >
        <p>Para comprobar que la anotaste bien, escribí estas dos palabras.</p>
        {positions.map((i) => (
          <Field
            key={i}
            label={`Palabra ${String(i + 1)}`}
            name={`word-${String(i)}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={typed[i] ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTyped((current) => ({ ...current, [i]: value }));
            }}
          />
        ))}
        {confirmOptions}
        {(confirmError ?? error) && <Notice tone="error">{confirmError ?? error}</Notice>}
        <div className="actions">
          <button type="submit" className="button" disabled={pending}>
            {pending ? 'Cifrando tu clave R…' : confirmLabel}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={pending}
            onClick={() => {
              setNoted(false);
              setStep('write');
            }}
          >
            Volver a ver las palabras
          </button>
        </div>
      </form>
    </section>
  );
}
