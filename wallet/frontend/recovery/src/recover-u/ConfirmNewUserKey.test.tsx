// @vitest-environment jsdom
// P19.T04 con la comparación reforzada de U′ ([F-LNK-04], ESC-41): la pantalla no muestra la U′ del backend antes de
// que coincida (ni en el texto ni en atributos), pide copiarla de la app Wallet en 10 grupos con el 0x fijo, reparte la
// dirección pegada, relee el borrador antes de aceptar, marca los grupos que no coinciden sin revelar lo esperado y a
// los 3 intentos bloquea ese borrador con qué hacer. Sólo al coincidir entrega la U′ confirmada.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getAddress, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressGroups } from '../ui/AddressText.tsx';
import { BLOCKED_TEXT, MISMATCH_TEXT, REREAD_ERROR_TEXT, type UserKeyDraft } from './compare.ts';
import { ConfirmNewUserKey } from './ConfirmNewUserKey.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** La U′ que generó la Wallet (la que ve el usuario) y una U″ que un backend comprometido pondría en su lugar. */
const U_WALLET: Address = getAddress('0x5a3c9b11e0f4d2a7c8b6e5f4a3b2c1d0e9f8a7b6');
const U_SWAPPED: Address = getAddress('0x0123456789abcdef0123456789abcdef01234567');
let next = 0;
const draft = (newKey: Address): UserKeyDraft => ({ id: `rot-ui-${String(++next)}`, newKey });

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount(props: Parameters<typeof ConfirmNewUserKey>[0]): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConfirmNewUserKey {...props} />);
    await Promise.resolve();
  });
  cleanup = async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  };
  return container;
}

const field = (c: HTMLElement, i: number) => {
  const input = c.querySelector<HTMLInputElement>(`#field-u-group-${String(i)}`);
  if (!input) throw new Error(`falta el grupo ${String(i + 1)}`);
  return input;
};

/** Escribe como el navegador: con el setter nativo (no el de React) y el evento `input`. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function paste(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    input.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function typeAll(c: HTMLElement, groups: readonly string[]): Promise<void> {
  for (const [i, group] of groups.entries()) await type(field(c, i), group);
}

async function confirm(c: HTMLElement): Promise<void> {
  const form = c.querySelector('form');
  if (!form) throw new Error('falta el formulario');
  await act(async () => {
    form.requestSubmit();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Ningún grupo de esa dirección aparece en la pantalla (texto ni atributos). */
function expectHidden(c: HTMLElement, address: Address): void {
  const html = c.innerHTML.toLowerCase();
  expect(html).not.toContain(address.slice(2).toLowerCase());
  for (const group of addressGroups(address)) expect(html).not.toContain(group.toLowerCase());
}

describe('confirmar la U′ antes de firmar', () => {
  it('10 grupos con el 0x fijo antes del primero; la U′ del backend no está en la pantalla', async () => {
    const d = draft(U_WALLET);
    const c = await mount({ draft: d, reread: () => Promise.resolve(d), onConfirmed: vi.fn() });
    expect(c.querySelectorAll('input')).toHaveLength(10);
    expect(c.querySelector('label[for="field-u-group-0"]')?.textContent).toBe('Grupo 1 de 10');
    expect(c.querySelector('label[for="field-u-group-9"]')?.textContent).toBe('Grupo 10 de 10');
    const prefix = c.querySelector('.address-group__prefix');
    expect(prefix?.textContent).toBe('0x');
    expect(prefix?.nextElementSibling).toBe(field(c, 0));
    expect(c.querySelectorAll('.address-group__prefix')).toHaveLength(1);
    expect(c.textContent).toContain('Copiá la dirección completa de la clave U nueva que muestra la app Wallet');
    expectHidden(c, U_WALLET);
  });

  it('un 0x tipeado se ignora y pegar la dirección completa (como la muestra la Wallet) la reparte', async () => {
    const d = draft(U_WALLET);
    const onConfirmed = vi.fn();
    const c = await mount({ draft: d, reread: () => Promise.resolve(d), onConfirmed });
    await type(field(c, 0), '0x');
    expect(field(c, 0).value).toBe('');
    await paste(field(c, 3), `0x ${addressGroups(U_WALLET).join(' ')}`);
    expect([...c.querySelectorAll('input')].map((i) => i.value)).toEqual(addressGroups(U_WALLET));
    await confirm(c);
    expect(onConfirmed).toHaveBeenCalledWith({ id: d.id, newKey: U_WALLET });
  });

  it('coincide sin distinguir mayúsculas: entrega la U′ confirmada', async () => {
    const d = draft(U_WALLET);
    const onConfirmed = vi.fn();
    const reread = vi.fn(() => Promise.resolve({ ...d, newKey: U_WALLET.toLowerCase() as Address }));
    const c = await mount({ draft: d, reread, onConfirmed });
    await typeAll(
      c,
      addressGroups(U_WALLET).map((g) => g.toUpperCase()),
    );
    await confirm(c);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith({ id: d.id, newKey: U_WALLET });
  });

  it('una U″ cambiada por el backend: qué grupos fallan sin revelarla y, a los 3 intentos, bloqueado', async () => {
    const d = draft(U_SWAPPED);
    const onConfirmed = vi.fn();
    const c = await mount({ draft: d, reread: () => Promise.resolve(d), onConfirmed });
    // El usuario copia la que muestra la Wallet.
    await typeAll(c, addressGroups(U_WALLET));
    await confirm(c);
    const mismatch = c.querySelector('[data-mismatch-groups]');
    expect(mismatch?.textContent).toContain(MISMATCH_TEXT);
    expect(mismatch?.textContent).toMatch(/no parece un error de tipeo\. No firmes esta propuesta/);
    expect(field(c, 0).getAttribute('aria-invalid')).toBe('true');
    expectHidden(c, U_SWAPPED);
    await confirm(c);
    expectHidden(c, U_SWAPPED);
    await confirm(c);
    expect(c.querySelector('[data-u-blocked]')?.textContent).toBe(BLOCKED_TEXT);
    expect(c.querySelector('form')).toBeNull();
    expectHidden(c, U_SWAPPED);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('un error de tipeo: el grupo que no coincide y los intentos que quedan', async () => {
    const d = draft(U_WALLET);
    const c = await mount({ draft: d, reread: () => Promise.resolve(d), onConfirmed: vi.fn() });
    const typed = addressGroups(U_WALLET);
    typed[5] = 'ffff';
    await typeAll(c, typed);
    await confirm(c);
    expect(c.querySelector('[data-mismatch-groups]')?.getAttribute('data-mismatch-groups')).toBe('6');
    expect(c.textContent).toContain('revisá el grupo 6 y volvé a confirmar (te quedan 2 intentos)');
    expect(field(c, 5).getAttribute('aria-invalid')).toBe('true');
    expect(field(c, 4).hasAttribute('aria-invalid')).toBe(false);
  });

  it('sin poder releer el borrador no compara (ni cuenta el intento); se compara con el borrador vigente', async () => {
    const d = draft(U_SWAPPED);
    const onConfirmed = vi.fn();
    const reread = vi
      .fn<() => Promise<UserKeyDraft | null>>()
      .mockRejectedValueOnce(new Error('sin red'))
      // La Wallet registró otra U′ (la que ve el usuario) en la misma rotación.
      .mockResolvedValue({ id: d.id, newKey: U_WALLET });
    const c = await mount({ draft: d, reread, onConfirmed });
    await typeAll(c, addressGroups(U_WALLET));
    await confirm(c);
    expect(c.textContent).toContain(REREAD_ERROR_TEXT);
    expect(c.querySelector('[data-mismatch-groups]')).toBeNull();
    expect(onConfirmed).not.toHaveBeenCalled();
    await confirm(c);
    expect(onConfirmed).toHaveBeenCalledWith({ id: d.id, newKey: U_WALLET });
  });
});
