// Codificaciones de bytes del módulo crypto de Recovery (P19.T02): hex con prefijo 0x, base64url sin relleno y UTF-8.
// Propias de esta app (sin código compartido con Wallet, §8). Estrictas al decodificar: las entradas llegan de archivos,
// QR, links y el backend, y una forma no canónica se rechaza en lugar de interpretarse.
export type Hex = `0x${string}`;

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class EncodingError extends Error {
  override name = 'EncodingError';
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}

/** `0x` + pares hexadecimales (sin distinguir mayúsculas); con `length`, exactamente esa cantidad de bytes. */
export function hexToBytes(hex: string, length?: number): Uint8Array {
  if (!HEX.test(hex)) throw new EncodingError('hex inválido');
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  if (length !== undefined && bytes.length !== length) throw new EncodingError(`se esperaban ${String(length)} bytes`);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url sin relleno y canónico (los bits sobrantes en cero); con `length`, exactamente esa cantidad de bytes. */
export function base64UrlToBytes(text: string, length?: number): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new EncodingError('base64url inválido');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== text) throw new EncodingError('base64url no canónico');
  if (length !== undefined && bytes.length !== length) throw new EncodingError(`se esperaban ${String(length)} bytes`);
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Sobrescribe con ceros (best-effort, [F-KEY-05]); un buffer ya transferido a un worker tiene largo 0 y no se toca. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Los bytes en un `Uint8Array<ArrayBuffer>` propio (lo que tipan las APIs de WebCrypto); se borra con `wipe`. */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}
