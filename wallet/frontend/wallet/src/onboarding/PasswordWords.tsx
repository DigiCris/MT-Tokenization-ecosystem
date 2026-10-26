// Password U ([F-KEY-02]): la app la genera (5 palabras), el usuario la anota y la confirma reingresando 2 palabras al
// azar. Nunca se envía ni se guarda; se muestra una vez por flujo. El papel lleva un rótulo con la dirección abreviada
// de la U que abre (cuarta revisión de P17.MAN, hallazgo 1): la de U′ no se confunde con la de la U anterior.
import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import { confirmationMatches, confirmationPositions } from '../crypto/password.ts';
import { Field, Notice } from '../ui/forms.tsx';
import { passwordUPaperText } from './user-key.ts';

export function ShowPasswordWords({
  words,
  keyAddress,
  onWritten,
}: {
  words: readonly string[];
  /** La U que abre esta Password U (en el alta y en U′ ya existe al mostrarla; al cambiarla o restaurar, es la misma). */
  keyAddress: Address;
  onWritten: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <article className="card stack" aria-labelledby="password-words-title">
      <h2 id="password-words-title">Tu Password U</h2>
      <Notice tone="warning">
        Anotá estas 5 palabras en papel, en este orden. Están en inglés: copialas letra por letra, sin traducir ni
        corregir. Son la Password U: protegen tu clave y desbloquean la wallet. MT Wallet no las guarda ni puede
        recuperarlas, y no son la contraseña de tu cuenta.
      </Notice>
      <ol className="words" aria-label="Password U">
        {words.map((word, i) => (
          <li key={`${String(i)}-${word}`} className="words__item">
            <span className="words__index">{i + 1}</span> <span className="words__word">{word}</span>
          </li>
        ))}
      </ol>
      <p>{passwordUPaperText(keyAddress)}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            setChecked(event.currentTarget.checked);
          }}
        />
        Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.
      </label>
      <button type="button" className="button" disabled={!checked} onClick={onWritten}>
        Ya las anoté
      </button>
    </article>
  );
}

export function ConfirmPasswordWords({
  words,
  onConfirmed,
  onBack,
}: {
  words: readonly string[];
  onConfirmed: () => void;
  onBack: () => void;
}) {
  const positions = useMemo(() => confirmationPositions(), []);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card form"
      aria-labelledby="confirm-words-title"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const answers = positions.map((p) => {
          const input = form.elements.namedItem(`word-${String(p)}`);
          return input instanceof HTMLInputElement ? input.value : '';
        });
        if (confirmationMatches(words, positions, answers)) onConfirmed();
        else setError('Alguna palabra no coincide: revisá lo que anotaste.');
      }}
    >
      <h2 id="confirm-words-title">Confirmá tu Password U</h2>
      <p>Para comprobar que la anotaste bien, escribí estas dos palabras.</p>
      {positions.map((p) => (
        <Field
          key={p}
          label={`Palabra ${String(p + 1)}`}
          name={`word-${String(p)}`}
          autoComplete="off"
          spellCheck={false}
          required
        />
      ))}
      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button">
        Confirmar
      </button>
      <button type="button" className="button button--ghost" onClick={onBack}>
        Volver a ver las palabras
      </button>
    </form>
  );
}
