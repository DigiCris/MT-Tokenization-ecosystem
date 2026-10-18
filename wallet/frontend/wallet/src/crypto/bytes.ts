// Utilidades de bytes del módulo crypto: base64url (@scure/base), hex, comparación en tiempo constante y borrado
// best-effort de buffers con material sensible ([F-KEY-05]).
import { base64urlnopad, hex } from '@scure/base';

export type Hex = `0x${string}`;

export function toBase64Url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function fromBase64Url(text: string): Uint8Array {
  return base64urlnopad.decode(text);
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${hex.encode(bytes)}`;
}

export function fromHex(text: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(text)) throw new TypeError('hex inválido');
  return hex.decode(text.slice(2).toLowerCase());
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Sobrescribe con ceros (best-effort: el motor puede haber copiado el contenido antes). */
export function zeroize(...buffers: (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

/** Copia sobre un ArrayBuffer propio (WebCrypto y postMessage no aceptan vistas de buffers compartidos). */
export function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}
