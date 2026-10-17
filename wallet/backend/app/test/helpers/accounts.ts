// Cuentas de prueba: un usuario con email verificado y contraseña real (Argon2id con el pepper de la config) y un
// cliente que inicia sesión por POST /auth/login, igual que el frontend. Los flujos de registro y verificación por
// email se prueban aparte (test/auth) con el pipeline de email real.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { PasswordHasher } from '../../src/auth/password.ts';
import type { TestListener } from './api.ts';
import type { TestClient } from './client.ts';
import type { TestDatabase } from './db.ts';
import { codeFrom, waitForMessage } from './mailpit.ts';

export interface TestAccount {
  id: string;
  email: string;
  password: string;
}

export const randomEmail = (label = 'u') => `${label}-${randomBytes(5).toString('hex')}@test.invalid`;
export const randomPassword = () => `Pw-${randomBytes(12).toString('base64url')}`;

export async function createVerifiedUser(
  listener: TestListener,
  db: TestDatabase,
  options: { email?: string; password?: string } = {},
): Promise<TestAccount> {
  const email = options.email ?? randomEmail();
  const password = options.password ?? randomPassword();
  const { hash, pepperVersion } = await new PasswordHasher(listener.config.secrets.passwordPeppers).hash(password);
  const row = await db.app
    .insertInto('users')
    .values({
      platform_id: listener.config.platformId,
      email,
      password_hash: hash,
      pepper_version: pepperVersion,
      email_verified_at: sql`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, email, password };
}

/** Cliente con sesión iniciada por el endpoint real de login. */
export async function signedInClient(
  listener: TestListener,
  db: TestDatabase,
  options: { email?: string; password?: string; remoteAddress?: string } = {},
): Promise<{ client: TestClient; account: TestAccount }> {
  const account = await createVerifiedUser(listener, db, options);
  const client = listener.newClient(options.remoteAddress);
  const response = await client.post('/api/v1/auth/login', { email: account.email, password: account.password });
  if (response.statusCode !== 200)
    throw new Error(`login de prueba falló: ${String(response.statusCode)} ${response.body}`);
  return { client, account };
}

/**
 * Registro y verificación por la API con el email real (el pipeline de email del test tiene que estar corriendo):
 * POST /auth/register → código leído en Mailpit → POST /auth/verify-email (abre la sesión).
 */
export async function registerAndVerify(
  listener: TestListener,
  options: { email?: string; password?: string; remoteAddress?: string } = {},
): Promise<{ client: TestClient; account: TestAccount }> {
  const email = options.email ?? randomEmail();
  const password = options.password ?? randomPassword();
  const client = listener.newClient(options.remoteAddress);
  const registered = await client.post('/api/v1/auth/register', { email, password });
  if (registered.statusCode !== 202) throw new Error(`registro de prueba falló: ${String(registered.statusCode)}`);
  const message = await waitForMessage(email, (m) => m.subject.includes('Verificá tu email'));
  const verified = await client.post('/api/v1/auth/verify-email', { email, code: codeFrom(message) });
  if (verified.statusCode !== 200) throw new Error(`verificación de prueba falló: ${String(verified.statusCode)}`);
  return { client, account: { id: verified.json<{ user: { id: string } }>().user.id, email, password } };
}
