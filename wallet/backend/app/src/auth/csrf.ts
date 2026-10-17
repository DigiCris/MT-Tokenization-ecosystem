// CSRF [B-AUTH-05]: token = base64url(HMAC-SHA256(CSRF_SECRET, sessionId)), entregado por GET /auth/csrf y exigido
// en `X-CSRF-Token` por todo método no-GET. Antes de iniciar sesión (registro, login, reset) el token se ata a un id
// anónimo en una cookie `__Host-` propia; al crear la sesión el cliente pide un token nuevo.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Secret } from '../config/secret.ts';
import type { Client } from '../db/schema.ts';

export const CSRF_HEADER = 'x-csrf-token';

export const ANON_CSRF_COOKIE: Readonly<Record<Client, string>> = {
  WALLET: '__Host-mtw_csrf',
  RECOVERY: '__Host-mtr_csrf',
};

/** Vida de la cookie anónima: suficiente para completar un registro o un reset. */
export const ANON_CSRF_MAX_AGE_SECONDS = 2 * 3600;

export type CsrfBinding = { kind: 'session'; sessionId: string } | { kind: 'anonymous'; anonId: string };

function bindingValue(binding: CsrfBinding): string {
  return binding.kind === 'session' ? binding.sessionId : `anon:${binding.anonId}`;
}

export function newAnonId(): string {
  return randomBytes(32).toString('base64url');
}

export function csrfToken(secret: Secret<Buffer>, binding: CsrfBinding): string {
  return createHmac('sha256', secret.reveal()).update(bindingValue(binding), 'utf8').digest('base64url');
}

export function csrfTokenMatches(secret: Secret<Buffer>, binding: CsrfBinding, token: string): boolean {
  const expected = Buffer.from(csrfToken(secret, binding), 'base64url');
  const actual = Buffer.from(token, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
