// Montos en unidades mínimas del token (P18.T06): el texto que escribe el usuario se convierte con bigint y los
// decimales fijados, sin pasar por punto flotante; se muestran en formato es-AR (miles con punto, decimales con coma).
// Como la app muestra los miles con punto, un monto escrito con separador de miles ("1.000") es ambiguo: no se
// interpreta, se pregunta qué se quiso decir (P18.MAN).
export class AmountError extends Error {
  override name = 'AmountError';
}

/**
 * Un monto escrito con separador de miles, en es-AR ("1.000", "12.500,25", "1.000.000") o en inglés ("1,000.50",
 * "1,000,000"): lo que se quiso decir, sin separadores y con coma decimal. null si no tiene separador de miles.
 */
export function withoutThousands(text: string): string | null {
  const value = text.trim();
  const local = /^([1-9]\d{0,2}(?:\.\d{3})+)(?:,(\d+))?$/.exec(value);
  const english = /^([1-9]\d{0,2}(?:,\d{3})+)\.(\d+)$/.exec(value) ?? /^([1-9]\d{0,2}(?:,\d{3}){2,})$/.exec(value);
  const match = local ?? english;
  if (!match?.[1]) return null;
  const whole = match[1].replace(/[.,]/g, '');
  return match[2] === undefined ? whole : `${whole},${match[2]}`;
}

/**
 * "12", "12,5" o "12.50" → unidades mínimas: un solo separador decimal (coma o punto) y no más decimales que el token.
 * Sin separadores de miles: "1.000" (como la app muestra los montos) se rechaza preguntando si se quiso decir 1000.
 */
export function parseAmount(text: string, decimals: number): bigint {
  const value = text.trim();
  const meant = withoutThousands(value);
  if (meant !== null) {
    throw new AmountError(
      `¿Quisiste decir ${meant}? Escribí el monto sin separador de miles (y, si hace falta, una coma para los decimales).`,
    );
  }
  const match = /^(\d{1,15})(?:[.,](\d+))?$/.exec(value);
  if (!match) throw new AmountError('Escribí el monto con números y, si hace falta, una coma para los decimales.');
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) throw new AmountError(`El token admite hasta ${String(decimals)} decimales.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * Un monto decimal de máquina (el que manda el backend en un aviso: "1500", "1500.25"; punto decimal y sin separador
 * de miles) → unidades mínimas. No es para lo que tipea el usuario: eso va por `parseAmount`.
 */
export function parseDecimalAmount(text: string, decimals: number): bigint {
  const match = /^(\d{1,30})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new AmountError('monto con formato inválido');
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) throw new AmountError(`más de ${String(decimals)} decimales`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Unidades mínimas → texto es-AR con al menos `minFraction` decimales (sin perder precisión). */
export function formatAmount(units: bigint, decimals: number, minFraction = 2): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fraction.length < minFraction) fraction = fraction.padEnd(Math.min(minFraction, decimals), '0');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `,${fraction}`}`;
}

export type AmountReading = { ok: true; units: bigint; text: string } | { ok: false; message: string };

/**
 * Cómo se interpreta lo que se está escribiendo, para mostrarlo debajo del campo: el monto en es-AR ("1.000,00") o por
 * qué no se entiende. null con el campo vacío.
 */
export function readAmount(text: string, decimals: number): AmountReading | null {
  if (text.trim() === '') return null;
  try {
    const units = parseAmount(text, decimals);
    return { ok: true, units, text: formatAmount(units, decimals) };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}
