// Flags no sensibles del dispositivo en localStorage ([F-KEY-07]): preferencias y marcas de la UI (p. ej. que Drive ya
// se autorizó una vez, cuándo fue el último chequeo de salud del backup y su resultado, si el usuario eligió recordar el
// sobre cifrado). Nunca claves, passwords, sobres, tokens ni identificadores de sesión. Las marcas de la pestaña (p. ej.
// que el onboarding de una wallet ya pidió una R a Recovery) van en sessionStorage, con las mismas reglas: duran lo que
// la pestaña, también si se recarga. Junto con src/drive/oauth-state.ts es el único módulo con Web Storage (regla Semgrep
// mtw-fe-web-storage).

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

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(area: Storage | null, name: string): string | null {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  try {
    return area?.getItem(PREFIX + name) ?? null;
  } catch {
    return null;
  }
}

function write(area: Storage | null, name: string, value: string): void {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  if (!VALUE.test(value)) throw new TypeError('valor de flag inválido');
  try {
    area?.setItem(PREFIX + name, value);
  } catch {
    // Sin storage (modo privado estricto): los flags son sólo comodidad.
  }
}

export function readFlag(name: string): string | null {
  return read(storage(), name);
}

export function writeFlag(name: string, value: string): void {
  write(storage(), name, value);
}

export function clearFlag(name: string): void {
  if (!ALLOWED.test(name)) throw new TypeError(`flag inválido: ${name}`);
  try {
    storage()?.removeItem(PREFIX + name);
  } catch {
    // Ídem.
  }
}

/** Marca de esta pestaña (sessionStorage): sobrevive a una recarga y se va con la pestaña. */
export function readTabFlag(name: string): string | null {
  return read(tabStorage(), name);
}

export function writeTabFlag(name: string, value: string): void {
  write(tabStorage(), name, value);
}
