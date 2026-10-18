// JSON canónico (RFC 8785, JCS) para el release manifest y el archivo de contratos del sistema: claves ordenadas por
// unidades UTF-16, sin espacios y números en la forma de ECMAScript. Sólo admite los tipos que usan esos archivos
// (objetos, arrays, strings, enteros seguros, booleanos y null): cualquier otro valor es un error, no una conversión.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`JCS: sólo enteros seguros (${String(value)})`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      const item = value[key];
      if (item === undefined) throw new Error(`JCS: valor indefinido en ${key}`);
      return `${JSON.stringify(key)}:${canonicalize(item)}`;
    })
    .join(',')}}`;
}
