// JSON canónico (RFC 8785, JCS) para lo que se firma byte a byte: el objeto del enrollment de R y el sobre de envío de
// una firma ([B-PSES-06]). Claves ordenadas por unidades UTF-16; números y strings con la serialización de ECMAScript
// (la que pide la RFC). Sólo números enteros seguros: los montos y nonces viajan como strings.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('sólo enteros seguros en JSON canónico');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: Json) => canonicalize(item)).join(',')}]`;
  const record = value as { readonly [key: string]: Json };
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] as Json)}`)
    .join(',')}}`;
}
