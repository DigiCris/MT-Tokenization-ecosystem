// Flags no sensibles de Recovery en localStorage ([F-KEY-07]): sólo marcas como "ya diste el consentimiento de Drive en
// este dispositivo". Nunca claves, sobres, tokens ni direcciones. Es uno de los dos módulos con Web Storage permitido
// (eslint `no-restricted-globals` y la regla Semgrep mtw-fe-web-storage).

const PREFIX = 'mtw.recovery.flag.';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readFlag(name: string): string | null {
  return storage()?.getItem(PREFIX + name) ?? null;
}

export function writeFlag(name: string, value: string): void {
  try {
    storage()?.setItem(PREFIX + name, value);
  } catch {
    // Sin storage (modo privado o bloqueado) la marca no persiste: no es necesaria para operar.
  }
}

export function clearFlag(name: string): void {
  storage()?.removeItem(PREFIX + name);
}
