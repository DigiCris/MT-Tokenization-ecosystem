// Codificaciones de la herramienta (implementación propia, como cada app): hex, base64url sin padding y UTF-8, y el
// borrado best-effort de bytes sensibles.
export type Hex = `0x${string}`;

export class EncodingError extends Error {
  override name = 'EncodingError';
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function hexToBytes(hex: string, length?: number): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})*$/.test(body)) throw new EncodingError('hex inválido');
  const bytes = Uint8Array.from(body.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  if (length !== undefined && bytes.length !== length) throw new EncodingError(`se esperaban ${String(length)} bytes`);
  return bytes;
}

export function base64UrlToBytes(text: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new EncodingError('base64url inválido');
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new EncodingError(`se esperaban ${String(length)} bytes`);
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Copia sobre un ArrayBuffer propio (lo que piden las APIs de WebCrypto). */
export function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
