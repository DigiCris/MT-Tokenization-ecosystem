// JSON canónico (RFC 8785, JCS) del envelope de envío ([B-PSES-06]): claves ordenadas por unidades UTF-16, sin espacios y
// números en la forma de ECMAScript. Sólo admite strings, enteros seguros, booleanos, null, arrays y objetos: cualquier
// otro valor es un error, nunca una conversión silenciosa.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`JCS: sólo enteros seguros (${String(value)})`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      const item = value[key];
      if (item === undefined) throw new TypeError(`JCS: valor indefinido en ${key}`);
      return `${JSON.stringify(key)}:${canonicalize(item)}`;
    })
    .join(',')}}`;
}
