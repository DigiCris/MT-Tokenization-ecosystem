// Redacción de logs y de payloads de auditoría [B-OBS]. Se aplica en profundidad (cualquier nivel de anidamiento) por
// nombre de clave, además de truncar IPs y enmascarar emails. Los tests de canario siembran valores secretos y
// verifican que nunca aparecen en la salida.

export const REDACTED = '[REDACTED]';

/** Claves sensibles de [B-OBS] (comparación sin mayúsculas ni separadores). */
const SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwordU',
    'passwordR',
    'otp',
    'code',
    'token',
    'authorization',
    'cookie',
    'set-cookie',
    'x-platform-session',
    'x-session-signature',
    'x-csrf-token',
    'privateKey',
    'secret',
    'mnemonic',
    'seed',
    'registrationRecord',
    'refreshToken',
    'accessToken',
    'apiKey',
    'recoveryCodes',
  ].map(normalizeKey),
);

/** Sufijos que también se redactan (p. ej. `sessionToken`, `clientSecret`, `PASSWORD_PEPPER_V1`). */
const SENSITIVE_SUFFIXES = ['password', 'token', 'secret', 'privatekey', 'mnemonic', 'pepper', 'apikey'];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  // Las versiones (`PASSWORD_PEPPER_V1`, `secretV2`) no cambian la sensibilidad de la clave.
  const unversioned = k.replace(/v\d+$/, '');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_SUFFIXES.some((s) => k.endsWith(s) || unversioned.endsWith(s));
}

const EMAIL_KEYS = new Set(['email', 'to', 'from', 'replyto'].map(normalizeKey));
const IP_KEYS = new Set(['ip', 'ips', 'remoteaddress', 'clientip', 'xforwardedfor', 'xrealip'].map(normalizeKey));

/** IPv4 → /24 e IPv6 → /48 (lo que se guarda como `ip_prefix`). */
export function truncateIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) {
    const parts = expandIpv6(ip);
    if (parts) return `${parts.slice(0, 3).join(':')}::/48`;
  }
  return REDACTED;
}

function expandIpv6(ip: string): string[] | null {
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!/^[0-9a-f:]+$/i.test(clean)) return null;
  const [head = '', tail] = clean.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...h, ...Array<string>(missing).fill('0'), ...t].map((p) => p.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** `ana@dominio.com` → `a***@dominio.com`. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return REDACTED;
  return `${value[0] ?? ''}***${value.slice(at)}`;
}

// El usuario puede estar vacío (`redis://:password@host`).
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]*):([^@/\s]+)@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;

/** Limpia strings libres (mensajes de error de drivers): credenciales en URLs y tokens Bearer/Basic. */
export function scrubString(value: string): string {
  return value.replace(CREDENTIAL_URL, `$1$2:${REDACTED}@`).replace(BEARER, `$1 ${REDACTED}`);
}

const MAX_DEPTH = 8;

/** Copia redactada de un valor arbitrario (no modifica el original). */
export function redact(value: unknown, depth = 0, parentKey = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const k = normalizeKey(parentKey);
    if (EMAIL_KEYS.has(k) && value.includes('@')) return maskEmail(value);
    if (IP_KEYS.has(k))
      return value
        .split(',')
        .map((ip) => truncateIp(ip.trim()))
        .join(', ');
    return scrubString(value);
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (value instanceof Error) return redactError(value, depth);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, parentKey));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(inner, depth + 1, key);
  }
  return out;
}

export function redactError(error: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubString(error.message),
  };
  if (error.stack) out.stack = scrubString(error.stack);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  if (error.cause !== undefined && depth < MAX_DEPTH) out.cause = redact(error.cause, depth + 1);
  return out;
}
