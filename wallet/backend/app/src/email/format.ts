// Formato de los datos que muestran los emails [B-MAIL-02]. Las direcciones y los montos salen con el mismo formato que
// en las apps Wallet y Recovery: es lo que se le pide al usuario comparar a mano entre la app y el email.
import { getAddress } from 'viem';
import type { AppEnv } from '../config/env.ts';

/** Dirección completa con checksum EIP-55 como la muestran las apps: `0x ` y sus 10 grupos de 4 (`0x 5A3c 9B11 …`). */
export function groupedAddress(address: string): string {
  const checksummed = getAddress(address);
  return `0x ${(checksummed.slice(2).match(/.{4}/g) ?? []).join(' ')}`;
}

/**
 * Monto en unidades mínimas del token → es-AR con el token, como en las apps: miles con punto, coma decimal, al menos 2
 * decimales y sin perder precisión (`1000000000` con 6 decimales → `1.000,00 USDC`).
 */
export function tokenAmount(units: string | bigint, token: string, decimals: number): string {
  if (typeof units === 'string' && !/^\d+$/.test(units)) {
    throw new Error('monto inválido: se esperan unidades mínimas del token (sólo dígitos)');
  }
  const value = BigInt(units);
  if (value < 0n) throw new Error('monto inválido: negativo');
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(Math.min(2, decimals), '0');
  return `${whole}${fraction === '' ? '' : `,${fraction}`} ${token}`;
}

/** Fecha en la zona horaria del usuario y en UTC. */
export function dualTime(iso: string, locale: string, timeZone: string): { local: string; utc: string } {
  const date = new Date(iso);
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  return { local: `${fmt(timeZone)} (${timeZone})`, utc: `${fmt('UTC')} UTC` };
}

/** "Base mainnet — chainId 8453" fuera de local; "Base fork local — chainId 8453" en local. */
export function networkLabel(appEnv: AppEnv, override?: string): string {
  if (override) return override;
  return appEnv === 'local' ? 'Base fork local — chainId 8453' : 'Base mainnet — chainId 8453';
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
