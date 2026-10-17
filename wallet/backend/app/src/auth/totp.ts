// TOTP [B-AUTH-09] (RFC 6238: SHA-1, 6 dígitos, 30 s, ventana ±1 paso): secreto de 160 bits cifrado con
// APP_FIELD_ENCRYPTION_KEY (AES-256-GCM, AAD = userId), anti-replay por el último paso usado y 10 códigos de
// recuperación de un solo uso guardados como hash Argon2id.
import { randomBytes } from 'node:crypto';
import { hash, verify, type Options } from '@node-rs/argon2';
import { Secret as OtpSecret, TOTP } from 'otpauth';
import type { Secret } from '../config/secret.ts';
import { decryptField, encryptField } from '../lib/field-crypto.ts';
import { ARGON2ID } from './password.ts';

export const TOTP_PARAMS = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = 'MT Wallet';

/** Argon2id para códigos de recuperación (50 bits de entropía cada uno): parámetros mínimos de OWASP. */
const RECOVERY_ARGON2: Options = { algorithm: ARGON2ID, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 };

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function sealTotpSecret(key: Secret<Buffer>, userId: string, secret: Buffer): Buffer {
  return encryptField(key, secret, `totp:${userId}`);
}

export function openTotpSecret(key: Secret<Buffer>, userId: string, sealed: Buffer): Buffer {
  return decryptField(key, sealed, `totp:${userId}`);
}

function totpFor(secret: Buffer, label = 'cuenta'): TOTP {
  const bytes = new Uint8Array(secret);
  return new TOTP({ issuer: TOTP_ISSUER, label, secret: new OtpSecret({ buffer: bytes.buffer }), ...TOTP_PARAMS });
}

/** URI otpauth:// para el QR de la app autenticadora. */
export function totpUri(secret: Buffer, email: string): string {
  return totpFor(secret, email).toString();
}

export function base32Secret(secret: Buffer): string {
  return new OtpSecret({ buffer: new Uint8Array(secret).buffer }).base32;
}

export type TotpCheck = { ok: true; step: bigint } | { ok: false; reason: 'INVALID' | 'REPLAY' };

/** Verifica un código; rechaza un paso ya usado o anterior (anti-replay). */
export function verifyTotp(secret: Buffer, token: string, lastUsedStep: bigint | null, now = Date.now()): TotpCheck {
  if (!/^\d{6}$/.test(token)) return { ok: false, reason: 'INVALID' };
  const delta = totpFor(secret).validate({ token, timestamp: now, window: TOTP_WINDOW });
  if (delta === null) return { ok: false, reason: 'INVALID' };
  const step = BigInt(TOTP.counter({ period: TOTP_PARAMS.period, timestamp: now }) + delta);
  if (lastUsedStep !== null && step <= lastUsedStep) return { ok: false, reason: 'REPLAY' };
  return { ok: true, step };
}

/** Código TOTP para un instante (lo usan los tests y la herramienta de sesión de desarrollo). */
export function totpCode(secret: Buffer, timestamp = Date.now()): string {
  return totpFor(secret).generate({ timestamp });
}

/** 10 códigos `XXXXX-XXXXX` (alfabeto sin caracteres ambiguos, 50 bits cada uno). */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = [...randomBytes(10)].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length] ?? 'A');
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return hash(normalizeRecoveryCode(code), RECOVERY_ARGON2);
}

/** Índice del código de recuperación que coincide, o -1. */
export async function matchRecoveryCode(code: string, hashes: readonly string[]): Promise<number> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) return -1;
  for (const [index, stored] of hashes.entries()) {
    if (await verify(stored, normalized).catch(() => false)) return index;
  }
  return -1;
}
