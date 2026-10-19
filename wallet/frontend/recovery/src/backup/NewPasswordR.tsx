// Password R nueva ([F-KEY-02]): la app genera 5 palabras, el usuario las anota y confirma 2 al azar. La usan la creación
// de R (P19.T03) y el re-cifrado de R restaurada desde las 17 palabras (P19.T08).
import { useCallback, useMemo, useState } from 'react';
import { confirmationPositions, confirmsPassword, newPasswordR } from '../crypto/password.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { Words } from '../ui/Words.tsx';

export function NewPasswordR({
  pending,
  error,
  generateLabel,
  confirmLabel,
  onConfirmed,
}: {
  pending: boolean;
  error: string | null;
  generateLabel: string;
  confirmLabel: string;
  onConfirmed: (words: string[]) => void;
}) {
  const [words, setWords] = useState<string[] | null>(null);
  const [step, setStep] = useState<'write' | 'confirm'>('write');
  const [noted, setNoted] = useState(false);
  const positions = useMemo(() => confirmationPositions(), []);
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
        <p>Anotá estas 5 palabras en orden. Sin ellas no vas a poder abrir el sobre cifrado de R.</p>
        <Words words={words} label="Password R" />
        <label className="check">
          <input
            type="checkbox"
            checked={noted}
            onChange={(event) => {
              setNoted(event.currentTarget.checked);
            }}
          />{' '}
          Anoté las 5 palabras en un lugar seguro
        </label>
        <button
          type="button"
          className="button"
          disabled={!noted}
          onClick={() => {
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
        {positions.map((i) => (
          <Field
            key={i}
            label={`Palabra ${String(i + 1)}`}
            name={`word-${String(i)}`}
            autoComplete="off"
            spellCheck={false}
            required
            value={typed[i] ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTyped((current) => ({ ...current, [i]: value }));
            }}
          />
        ))}
        {(confirmError ?? error) && <Notice tone="error">{confirmError ?? error}</Notice>}
        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Cifrando tu clave R…' : confirmLabel}
        </button>
      </form>
    </section>
  );
}
