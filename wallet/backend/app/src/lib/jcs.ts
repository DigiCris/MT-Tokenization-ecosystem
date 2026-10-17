// JSON canónico RFC 8785 (JCS). Lo usan la cadena de auditoría, el hash de requests idempotentes y los formatos
// compartidos de §7.15. Implementación propia del backend (cada consumidor implementa los formatos por separado).
//
// - Claves ordenadas por unidades de código UTF-16 (el orden de `<` en JavaScript).
// - Strings y números con la serialización de ECMAScript (`JSON.stringify`), que es la que exige el RFC.
// - Se rechazan NaN/Infinity, bigint, funciones y símbolos; `undefined` se omite en objetos (como JSON) y se rechaza
//   en arrays.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('JCS: número no finito');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item: unknown) => {
            if (item === undefined) throw new CanonicalJsonError('JCS: undefined dentro de un array');
            return canonicalJson(item);
          })
          .join(',')}]`;
      }
      if (value instanceof Date) throw new CanonicalJsonError('JCS: Date sin convertir (usar toISOString)');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new CanonicalJsonError(`JCS: tipo no serializable (${typeof value})`);
  }
  throw new CanonicalJsonError('JCS: tipo desconocido');
}
