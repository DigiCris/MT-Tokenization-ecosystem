// Primitivas de formulario de Recovery (propias de esta app): campo con etiqueta, aviso con tono y una acción asíncrona
// con su estado (pendiente / error) para los botones. Sin librerías de UI ni HTML generado (Trusted Types).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { describeError } from './errors.ts';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = `field-${input.name}`;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <input id={id} className="field__input" {...input} />
      {hint !== undefined && <p className="field__hint">{hint}</p>}
    </div>
  );
}

/** Lista desplegable con su etiqueta asociada por id (el nombre accesible es la etiqueta, no las opciones). */
export function SelectField({
  label,
  children,
  ...select
}: { label: string; name: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = `field-${select.name}`;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <select id={id} className="field__input" {...select}>
        {children}
      </select>
    </div>
  );
}

/** Texto de varias líneas con su etiqueta asociada por id. */
export function TextAreaField({
  label,
  ...textarea
}: { label: string; name: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = `field-${textarea.name}`;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <textarea id={id} className="field__input" {...textarea} />
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Valor de un campo: input, textarea, select o el radio elegido de un grupo. */
export function formValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  if (element instanceof RadioNodeList) return element.value;
  return element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
    ? element.value
    : '';
}

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<void>;
  pending: boolean;
  error: string | null;
  reset: () => void;
}

/** Acción con estado para un botón: un solo vuelo a la vez, el error como texto y nada después de desmontar. */
export function useAsyncAction<A extends unknown[]>(action: (...args: A) => Promise<void>): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        await action(...args);
      } catch (caught) {
        if (mounted.current) setError(describeError(caught));
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [action],
  );
  const reset = useCallback(() => {
    setError(null);
  }, []);
  return { run, pending, error, reset };
}
