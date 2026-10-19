// JSON canónico RFC 8785 (JCS), implementación propia del monitor: el manifest de release ([W-04]) tiene que estar
// escrito exactamente en esta forma (si no, la firma podría cubrir bytes que otro lector interpreta distinto) y las
// aprobaciones de los operadores se firman sobre esta forma.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: número no finito');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  // Claves ordenadas por unidades UTF-16 (el orden por defecto de sort en JavaScript).
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as Json)}`).join(',')}}`;
}
