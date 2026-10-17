// Redacción de logs del signer [B-OBS]: por nombre de campo, en profundidad. El signer nunca pasa claves privadas ni
// credenciales al logger; esto es una segunda barrera (tokens de sesión, firmas de envelope, contraseñas, etc.).
const SENSITIVE_KEY =
  /^(?:private_?key|privkey|secret|secrets|password|passphrase|credential|unlock|mnemonic|seed|token|platform_?session_?token|authorization|cookie|set-cookie|x-platform-session|x-session-signature|signature_?key|keystore|ciphertext|mac|derived_?key|attestation_?key)$/i;

const MAX_DEPTH = 8;
export const REDACTED = '[redactado]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || /private|secret|password|credential|mnemonic/i.test(key);
}

export function redact(value: unknown, depth = 0, key = ''): unknown {
  if (key !== '' && isSensitiveKey(key)) return REDACTED;
  if (depth > MAX_DEPTH) return '[profundidad]';
  if (value instanceof Error) {
    return { type: value.name, message: scrubString(value.message), code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1, k);
    return out;
  }
  return typeof value === 'string' ? scrubString(value) : value;
}

/** Limpia credenciales embebidas en texto (URLs con usuario/password, Bearer, JWS compactos). */
export function scrubString(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redactado]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redactado]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jws redactado]');
}
