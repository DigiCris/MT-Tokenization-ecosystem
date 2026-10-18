// Montos en unidades mínimas del token (P18.T06): el texto que escribe el usuario se convierte con bigint y los
// decimales fijados, sin pasar por punto flotante; se muestran en formato es-AR (miles con punto, decimales con coma).
export class AmountError extends Error {
  override name = 'AmountError';
}

/** "12", "12,5" o "12.50" → unidades mínimas. Sin separadores de miles (son ambiguos) ni más decimales que el token. */
export function parseAmount(text: string, decimals: number): bigint {
  const value = text.trim();
  const match = /^(\d{1,15})(?:[.,](\d+))?$/.exec(value);
  if (!match) throw new AmountError('Escribí el monto con números y, si hace falta, una coma para los decimales.');
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) throw new AmountError(`El token admite hasta ${String(decimals)} decimales.`);
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
