// Códigos de un solo uso [B-AUTH-02]: OTP de 8 dígitos (CSPRNG) y tokens de 256 bits (reset de password). En la base
// sólo queda HMAC-SHA256(OTP_HMAC_KEY, challengeId ‖ código): el id del challenge evita reusar un hash en otra fila.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Secret } from '../config/secret.ts';

export const OTP_DIGITS = 8;

export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_DIGITS)
    .toString()
    .padStart(OTP_DIGITS, '0');
}

/** 256 bits en base64url. */
export function generateSecretToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashChallengeSecret(key: Secret<Buffer>, challengeId: string, secret: string): Buffer {
  return createHmac('sha256', key.reveal()).update(`${challengeId}:${secret}`, 'utf8').digest();
}

/** Comparación en tiempo constante. */
export function secretsMatch(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
