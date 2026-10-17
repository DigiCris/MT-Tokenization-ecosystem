// Reglas de calidad de secretos (P08.T02): valores de ejemplo y baja entropía se rechazan antes de arrancar.
// Los mensajes nombran la regla incumplida, nunca el valor.

const EXAMPLE_VALUE =
  /^(?:change[-_ ]?me|replace[-_ ]?me|example|placeholder|secret|password|passw0rd|test|dummy|sample|todo|default|xxx+|\*+|<[^>]*>|\$\{[^}]*\}|your[-_].*)$/i;

/** Valores de documentación o de ejemplo, en cualquier variable. */
export function isExampleValue(value: string): boolean {
  return (
    EXAMPLE_VALUE.test(value.trim()) || /(?:^|[^a-z])(?:example\.(?:com|org|net)|changeme)(?:$|[^a-z])/i.test(value)
  );
}

/** Entropía de Shannon estimada en bits (longitud × entropía por carácter). */
export function shannonBits(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const c of counts.values()) {
    const p = c / value.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * value.length;
}

const STANDARD_B64_32 = /^[A-Za-z0-9+/]{43}=$/;
const URLSAFE_B64_32 = /^[A-Za-z0-9_-]{43}$/;

/** Clave simétrica de 32 bytes en base64 (estándar con padding o base64url sin padding). */
export function parseKey32(value: string): { key: Buffer } | { error: string } {
  if (isExampleValue(value)) return { error: 'es un valor de ejemplo' };
  const encoding = STANDARD_B64_32.test(value) ? 'base64' : URLSAFE_B64_32.test(value) ? 'base64url' : null;
  if (!encoding) return { error: 'debe ser una clave de 32 bytes en base64' };
  const key = Buffer.from(value, encoding);
  if (key.length !== 32) return { error: 'debe ser una clave de 32 bytes en base64' };
  // 32 bytes aleatorios tienen ~30 valores distintos; menos de 20 indica una clave fabricada (ceros, patrones).
  if (new Set(key).size < 20) return { error: 'tiene baja entropía' };
  return { key };
}

/** Password (de base de datos, de Valkey) o token de API con entropía suficiente. */
export function passwordProblem(value: string, minBits = 64): string | null {
  if (isExampleValue(value)) return 'es un valor de ejemplo';
  if (value.length < 16) return 'es demasiado corto (mínimo 16 caracteres)';
  if (shannonBits(value) < minBits) return 'tiene baja entropía';
  return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** URL de PostgreSQL o Valkey: el password embebido tiene que ser fuerte. */
export function connectionUrlProblem(raw: string, protocols: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'no es una URL válida';
  }
  if (!protocols.includes(url.protocol)) return `el protocolo debe ser ${protocols.join(' o ')}`;
  const password = decodeURIComponent(url.password);
  if (!password) return 'no incluye password';
  const problem = passwordProblem(password);
  return problem ? `el password ${problem}` : null;
}

/** URL de un proveedor RPC remoto: https, host no local y una credencial (API key/token) en la ruta o el query. */
export function remoteRpcUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'no es una URL válida';
  }
  if (url.protocol !== 'https:') return 'debe usar https';
  if (isLocalHost(url.hostname)) return 'no puede apuntar a un host local';
  const tokens = [...url.pathname.split('/'), ...[...url.searchParams.values()]].filter((t) => t.length >= 16);
  if (tokens.length === 0) return 'no incluye la credencial del proveedor';
  if (tokens.some((t) => isExampleValue(t))) return 'la credencial es un valor de ejemplo';
  if (!tokens.some((t) => shannonBits(t) >= 64)) return 'la credencial tiene baja entropía';
  return null;
}
