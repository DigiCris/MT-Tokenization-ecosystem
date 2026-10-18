// Piezas de formulario de la app: campos con etiqueta y error asociados (accesibles), avisos con el rol correcto y un
// hook para acciones asincrónicas que muestran su estado y su error.
import { useCallback, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { describeError } from './errors.ts';

export function Field({
  label,
  hint,
  error,
  ...input
}: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Aviso fijo de la arquitectura de dos capas ([F-UI], ADR-008). */
export function AccountPasswordNotice() {
  return (
    <Notice tone="warning">
      <strong>Esta contraseña NO es tu Password U.</strong> La contraseña de cuenta sólo abre tu sesión; la Password U
      (5 palabras) protege tu clave y nunca sale de este navegador. Restablecer la contraseña de cuenta no recupera la
      Password U.
    </Notice>
  );
}

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<void>;
  pending: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

export function useAsyncAction<A extends unknown[]>(action: (...args: A) => Promise<void>): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        await action(...args);
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setPending(false);
      }
    },
    [action],
  );
  return { run, pending, error, setError };
}

/** Valor de un input de formulario por nombre. */
export function formValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '';
}
