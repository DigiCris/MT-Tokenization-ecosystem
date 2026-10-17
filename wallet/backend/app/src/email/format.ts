// Formato de los datos que muestran los emails [B-MAIL-02].
import { getAddress } from 'viem';
import type { AppEnv } from '../config/env.ts';

/** Dirección completa con checksum EIP-55 en grupos de 4: `0x5A3c 9B11 …`. */
export function groupedAddress(address: string): string {
  const checksummed = getAddress(address);
  return `0x${(checksummed.slice(2).match(/.{1,4}/g) ?? []).join(' ')}`;
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
