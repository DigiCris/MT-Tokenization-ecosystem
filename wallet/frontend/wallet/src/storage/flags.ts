// Flags no sensibles del dispositivo en localStorage ([F-KEY-07]): preferencias y marcas de la UI (p. ej. que Drive ya
// se autorizó una vez, cuándo fue el último chequeo de salud del backup y su resultado, si el usuario eligió recordar el
// sobre cifrado). Nunca claves, passwords, sobres, tokens ni identificadores de sesión. Junto con
// src/drive/oauth-state.ts es el único módulo con Web Storage (regla Semgrep mtw-fe-web-storage).

const PREFIX = 'mtw.flag.';
const ALLOWED = /^[a-z][a-zA-Z0-9.-]{1,63}$/;
const VALUE = /^[\w.:@+/=-]{0,256}$/;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readFlag(name: string): string | null {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  try {
    return storage()?.getItem(PREFIX + name) ?? null;
  } catch {
    return null;
  }
}

export function writeFlag(name: string, value: string): void {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  if (!VALUE.test(value)) throw new TypeError('valor de flag inválido');
  try {
    storage()?.setItem(PREFIX + name, value);
  } catch {
    // Sin storage (modo privado estricto): los flags son sólo comodidad.
  }
}

export function clearFlag(name: string): void {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  try {
    storage()?.removeItem(PREFIX + name);
  } catch {
    // Ídem.
  }
}
