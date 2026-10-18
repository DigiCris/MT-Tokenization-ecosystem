// Lado cliente de PlatformSession para los tests, con las mismas primitivas que usará el frontend: session key P-256,
// OPAQUE con @serenity-kit/opaque (entrada hex(AuthSecret_U)), binding de la session key y headers firmados de los
// requests críticos ([B-PSES-02/05]). El registro OPAQUE usa el servicio (su ruta, `user-key`, llega con las wallets).
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import { sql } from 'kysely';
import { getAddress, toHex, type Address } from 'viem';
import { withTransaction } from '../../src/db/transaction.ts';
import { jwkThumbprint, type P256PublicJwk } from '../../src/platform-session/keys.ts';
import { OPAQUE_KEY_STRETCHING, sessionKeyBinding } from '../../src/platform-session/opaque.ts';
import { canonicalRequest } from '../../src/platform-session/request-signature.ts';
import type { TestListener } from './api.ts';
import type { TestClient } from './client.ts';
import type { TestDatabase } from './db.ts';

await opaque.ready;

export interface SessionKey {
  privateKey: KeyObject;
  jwk: P256PublicJwk;
  thumbprint: string;
}

/** Session key P-256 nueva (en el navegador: WebCrypto con extractable=false). */
export function newSessionKey(): SessionKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = publicKey.export({ format: 'jwk' });
  const jwk: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: exported.x ?? '', y: exported.y ?? '' };
  return { privateKey, jwk, thumbprint: jwkThumbprint(jwk) };
}

/** Clave P-256 desde una JWK privada (vectores). */
export function sessionKeyFromJwk(jwk: P256PublicJwk & { d: string }): SessionKey {
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  const pub: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return { privateKey, jwk: pub, thumbprint: jwkThumbprint(pub) };
}

export function signP256(key: SessionKey, message: string): string {
  return sign('sha256', Buffer.from(message, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
}

/** AuthSecret_U de prueba: 32 bytes como los que deriva [F-KEY-03]; la entrada OPAQUE es su hex. */
export const newAuthSecret = () => randomBytes(32).toString('hex');

/** Wallet viva del usuario (ACTIVE con Safe y metadatos de U) como la deja el onboarding. */
export async function seedActiveWallet(
  db: TestDatabase,
  input: { userId: string; platformId: string; status?: 'ACTIVE' | 'CREATING' },
): Promise<{ walletId: string; safe: Address | null }> {
  const status = input.status ?? 'ACTIVE';
  const safe = status === 'ACTIVE' ? randomBytes(20) : null;
  const wallet = await db.app
    .insertInto('wallets')
    .values({
      user_id: input.userId,
      platform_id: input.platformId,
      chain_id: 8453,
      status,
      safe_address: safe,
      ...(status === 'ACTIVE' ? { activated_at: sql`now()` } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.app
    .insertInto('wallet_keys_metadata')
    .values({
      wallet_id: wallet.id,
      role: 'U',
      key_address: randomBytes(20),
      key_version: 1,
      status: 'ACTIVE',
      source: 'INTERNAL',
      kdf_params: JSON.stringify({
        alg: 'argon2id',
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 4,
        salt: randomBytes(16).toString('base64url'),
      }),
      activated_at: sql`now()`,
    })
    .execute();
  return { walletId: wallet.id, safe: safe ? getAddress(toHex(safe)) : null };
}

/** Registro OPAQUE completo (cliente real + servicio) y, si `activate`, ACTIVE como tras confirmar U on-chain. */
export async function registerOpaque(
  listener: TestListener,
  db: TestDatabase,
  input: { userId: string; walletId: string; keyVersion?: number; authSecretHex: string; activate?: boolean },
): Promise<{ recordId: string; exportKey: string }> {
  const keyVersion = input.keyVersion ?? 1;
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password: input.authSecretHex,
  });
  const registrationResponse = listener.services.opaque.registrationResponse({
    walletId: input.walletId,
    keyVersion,
    registrationRequest,
  });
  const { registrationRecord, exportKey } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: input.authSecretHex,
    keyStretching: OPAQUE_KEY_STRETCHING,
  });
  const recordId = await withTransaction(db.app, async (trx) => {
    const id = await listener.services.opaque.storeRegistration(trx, {
      userId: input.userId,
      walletId: input.walletId,
      keyVersion,
      registrationRecord,
    });
    if (input.activate ?? true) await listener.services.opaque.activate(trx, { walletId: input.walletId, keyVersion });
    return id;
  });
  return { recordId, exportKey };
}

export interface UnlockedSession {
  token: string;
  sessionId: string;
  key: SessionKey;
  session: {
    id: string;
    scope: string;
    walletId: string | null;
    safe: string | null;
    issuedAt: string;
    expiresAt: string;
  };
}

/** Desbloqueo por la API: OPAQUE start/finish con la session key atada. */
export async function unlockWallet(
  browser: TestClient,
  authSecretHex: string,
  key: SessionKey = newSessionKey(),
  walletId?: string,
): Promise<UnlockedSession> {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: authSecretHex });
  const started = await browser.post('/api/v1/platform-sessions/opaque/start', {
    startLoginRequest,
    sessionPublicKey: key.jwk,
    ...(walletId === undefined ? {} : { walletId }),
  });
  if (started.statusCode !== 200) throw new Error(`opaque/start: ${String(started.statusCode)} ${started.body}`);
  const { loginAttemptId, loginResponse } = started.json<{ loginAttemptId: string; loginResponse: string }>();
  const finished = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password: authSecretHex,
    keyStretching: OPAQUE_KEY_STRETCHING,
  });
  if (!finished) throw new Error('la Password U de prueba no abre el registro');
  const response = await browser.post('/api/v1/platform-sessions/opaque/finish', {
    loginAttemptId,
    finishLoginRequest: finished.finishLoginRequest,
    sessionKeyBinding: sessionKeyBinding(finished.sessionKey, key.jwk, loginAttemptId),
  });
  if (response.statusCode !== 200) throw new Error(`opaque/finish: ${String(response.statusCode)} ${response.body}`);
  const body = response.json<{ token: string; session: UnlockedSession['session'] }>();
  return { token: body.token, sessionId: body.session.id, key, session: body.session };
}

/** Headers de un request crítico firmado ([B-PSES-05]). */
export function signedHeaders(input: {
  token: string;
  sessionId: string;
  key: SessionKey;
  method: string;
  path: string;
  body: string;
  timestamp?: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const canonical = canonicalRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp,
    nonce,
    sessionId: input.sessionId,
  });
  return {
    'x-platform-session': input.token,
    'x-session-timestamp': timestamp,
    'x-session-nonce': nonce,
    'x-session-signature': signP256(input.key, canonical),
  };
}

/** POST /platform-sessions/check firmado (el body es `{}`, como lo serializa el cliente de prueba). */
export function checkSession(
  browser: TestClient,
  unlocked: Pick<UnlockedSession, 'token' | 'sessionId' | 'key'>,
  overrides: Partial<Parameters<typeof signedHeaders>[0]> = {},
) {
  const path = '/api/v1/platform-sessions/check';
  return browser.post(path, {}, signedHeaders({ ...unlocked, method: 'POST', path, body: '{}', ...overrides }));
}
