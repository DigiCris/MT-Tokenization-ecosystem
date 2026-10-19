// Pantallas montadas en jsdom para tests (React 19 con act): montar, dejar correr las respuestas simuladas de la API y
// la cadena, escribir en un campo como el navegador (React sigue el valor con su propio setter) y buscar por texto.
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

export async function render(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
    await Promise.resolve();
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

/** Deja correr las promesas en cola (varias vueltas: una respuesta puede disparar otra). */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Escribe en un input como el navegador: con el setter nativo (no el que instala React) y el evento `input`. */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

export async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
}

/** El elemento del selector cuyo texto es exactamente `text` (sin espacios de los bordes). */
export function byText(container: HTMLElement, selector: string, text: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.textContent.trim() === text,
  );
  if (!found) throw new Error(`no hay ${selector} con el texto "${text}"`);
  return found;
}

/** El input asociado a una etiqueta (`label[for]`), como lo encuentra quien lee la pantalla. */
export function byLabel(container: HTMLElement, label: string | RegExp): HTMLInputElement {
  const match = [...container.querySelectorAll('label')].find((element) => {
    const text = element.textContent.trim();
    return typeof label === 'string' ? text === label : label.test(text);
  });
  const id = match?.getAttribute('for');
  const input = id ? container.ownerDocument.getElementById(id) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no hay un campo con la etiqueta ${String(label)}`);
  return input;
}
