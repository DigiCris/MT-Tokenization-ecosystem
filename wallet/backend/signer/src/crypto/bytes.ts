// Conversión estricta entre hex y bytes: sólo `0x` + pares de dígitos hex; cualquier otra cosa es un error.
export type Hex = `0x${string}`;

export function isHex(value: unknown, bytes?: number): value is Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return false;
  return bytes === undefined || value.length === 2 + bytes * 2;
}

export function hexToBytes(value: string, bytes?: number): Uint8Array {
  if (!isHex(value, bytes)) {
    throw new TypeError(bytes === undefined ? 'hex inválido' : `hex inválido: se esperaban ${bytes} bytes`);
  }
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

export function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Sobrescribe un buffer con ceros (best-effort: el runtime puede haber copiado el contenido antes). */
export function wipe(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

/** Entero sin signo de 256 bits en big-endian. */
export function uint256ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError('fuera de rango uint256');
  return hexToBytes(`0x${value.toString(16).padStart(64, '0')}`);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
