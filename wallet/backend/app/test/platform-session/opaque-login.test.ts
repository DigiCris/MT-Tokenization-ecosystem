// P10.T03 [B-PSES-01/02]: desbloqueo de la Wallet por la API real. OPAQUE start/finish con el estado del servidor en
// Valkey (60 s, un solo uso) y binding de la session key → PlatformSession OPERATIONS de 15 min; Password U incorrecta,
// binding ajeno, intento reusado, vencido o de otra sesión de cuenta fallan igual (403 REAUTH_FAILED).
import { setTimeout as sleep } from 'node:timers/promises';
import * as opaque from '@serenity-kit/opaque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPAQUE_KEY_STRETCHING, sessionKeyBinding } from '../../src/platform-session/opaque.ts';
import { signedInClient, type TestAccount } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import type { TestClient } from '../helpers/client.ts';
import { newAuthSecret, newSessionKey, registerOpaque, seedActiveWallet, unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.opaqueLogin });
});
afterAll(async () => {
  await env.close();
});

interface Ready {
  browser: TestClient;
  account: TestAccount;
  walletId: string;
  safe: string | null;
  authSecret: string;
}

/** Usuario con sesión de cuenta, wallet ACTIVE y registro OPAQUE ACTIVE. */
async function ready(): Promise<Ready> {
  const { client: browser, account } = await signedInClient(env.wallet, env.db);
  const { walletId, safe } = await seedActiveWallet(env.db, {
    userId: account.id,
    platformId: env.wallet.config.platformId,
  });
  const authSecret = newAuthSecret();
  await registerOpaque(env.wallet, env.db, { userId: account.id, walletId, authSecretHex: authSecret });
  return { browser, account, walletId, safe, authSecret };
}

async function start(browser: TestClient, authSecret: string, key = newSessionKey()) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: authSecret });
  const response = await browser.post('/api/v1/platform-sessions/opaque/start', {
    startLoginRequest,
    sessionPublicKey: key.jwk,
  });
  return { response, clientLoginState, key };
}

describe('desbloqueo OPAQUE', () => {
  it('ida y vuelta: PlatformSession OPERATIONS de 15 min atada a la session key, la wallet y la sesión de cuenta', async () => {
    const r = await ready();
    const unlocked = await unlockWallet(r.browser, r.authSecret);
    expect(unlocked.session).toMatchObject({
      scope: 'OPERATIONS',
      authMethod: 'OPAQUE_U',
      walletId: r.walletId,
      safe: r.safe,
    });
    expect(Date.parse(unlocked.session.expiresAt) - Date.parse(unlocked.session.issuedAt)).toBe(15 * 60_000);

    const claims = await env.wallet.services.issuer.verify(unlocked.token);
    expect(claims).toMatchObject({
      userId: r.account.id,
      scope: 'OPERATIONS',
      sessionPublicKey: unlocked.key.jwk,
      aud: ['mtw-api', 'mtw-signer'],
    });
    const row = await env.db.app
      .selectFrom('platform_sessions')
      .selectAll()
      .where('id', '=', unlocked.sessionId)
      .executeTakeFirstOrThrow();
    const accountSession = await env.db.app
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', r.account.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      scope: 'OPERATIONS',
      auth_method: 'OPAQUE_U',
      wallet_id: r.walletId,
      account_session_id: accountSession.id,
      revoked_at: null,
    });
    expect(claims.accountSessionId).toBe(accountSession.id);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', r.account.id)
      .where('event_type', '=', 'PLATFORM_SESSION_ISSUED')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({
      platformSessionId: unlocked.sessionId,
      scope: 'OPERATIONS',
      authMethod: 'OPAQUE_U',
      keyVersion: 1,
    });
  });

  it('el estado del servidor vive en Valkey con TTL de 60 s y se consume una sola vez', async () => {
    const r = await ready();
    const { response, clientLoginState, key } = await start(r.browser, r.authSecret);
    expect(response.statusCode).toBe(200);
    const { loginAttemptId, loginResponse } = response.json<{ loginAttemptId: string; loginResponse: string }>();
    const ttl = await env.redis.pttl(`mtw:opaque:login:${loginAttemptId}`);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    const finished = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: r.authSecret,
      keyStretching: OPAQUE_KEY_STRETCHING,
    });
    if (!finished) throw new Error('debía abrir');
    const body = {
      loginAttemptId,
      finishLoginRequest: finished.finishLoginRequest,
      sessionKeyBinding: sessionKeyBinding(finished.sessionKey, key.jwk, loginAttemptId),
    };
    expect((await r.browser.post('/api/v1/platform-sessions/opaque/finish', body)).statusCode).toBe(200);
    const replay = await r.browser.post('/api/v1/platform-sessions/opaque/finish', body);
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toMatchObject({ code: 'REAUTH_FAILED' });
    expect(await env.redis.exists(`mtw:opaque:login:${loginAttemptId}`)).toBe(0);
  });

  it('un intento vencido (más de 60 s) ya no se puede terminar', async () => {
    const r = await ready();
    const { response, clientLoginState, key } = await start(r.browser, r.authSecret);
    const { loginAttemptId, loginResponse } = response.json<{ loginAttemptId: string; loginResponse: string }>();
    const finished = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: r.authSecret,
      keyStretching: OPAQUE_KEY_STRETCHING,
    });
    if (!finished) throw new Error('debía abrir');
    await sleep(61_000);
    const late = await r.browser.post('/api/v1/platform-sessions/opaque/finish', {
      loginAttemptId,
      finishLoginRequest: finished.finishLoginRequest,
      sessionKeyBinding: sessionKeyBinding(finished.sessionKey, key.jwk, loginAttemptId),
    });
    expect(late.statusCode).toBe(403);
    expect(late.json()).toMatchObject({ code: 'REAUTH_FAILED' });
  }, 90_000);

  it('Password U incorrecta: el cliente no puede terminar y un mensaje final forjado falla sin filtrar nada', async () => {
    const r = await ready();
    const wrong = newAuthSecret();
    const { response, clientLoginState } = await start(r.browser, wrong);
    expect(response.statusCode).toBe(200);
    const { loginAttemptId, loginResponse } = response.json<{ loginAttemptId: string; loginResponse: string }>();
    expect(
      opaque.client.finishLogin({
        clientLoginState,
        loginResponse,
        password: wrong,
        keyStretching: OPAQUE_KEY_STRETCHING,
      }),
    ).toBeUndefined();
    // Un atacante manda igual un mensaje final armado con otra corrida: el servidor lo rechaza.
    const other = opaque.client.startLogin({ password: wrong });
    const forged = await r.browser.post('/api/v1/platform-sessions/opaque/finish', {
      loginAttemptId,
      finishLoginRequest: other.startLoginRequest,
      sessionKeyBinding: 'A'.repeat(43),
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ code: 'REAUTH_FAILED', title: 'No se pudo confirmar tu identidad' });
    const failed = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', r.account.id)
      .where('event_type', '=', 'OPAQUE_LOGIN_FAILED')
      .executeTakeFirstOrThrow();
    expect(failed.payload).toMatchObject({ reason: 'FINISH', loginAttemptId });
    expect(
      await env.db.app.selectFrom('platform_sessions').select('id').where('user_id', '=', r.account.id).execute(),
    ).toEqual([]);
  });

  it('el binding ata la session key presentada al inicio: otra clave no sirve', async () => {
    const r = await ready();
    const { response, clientLoginState } = await start(r.browser, r.authSecret);
    const { loginAttemptId, loginResponse } = response.json<{ loginAttemptId: string; loginResponse: string }>();
    const finished = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: r.authSecret,
      keyStretching: OPAQUE_KEY_STRETCHING,
    });
    if (!finished) throw new Error('debía abrir');
    const attackerKey = newSessionKey();
    const result = await r.browser.post('/api/v1/platform-sessions/opaque/finish', {
      loginAttemptId,
      finishLoginRequest: finished.finishLoginRequest,
      sessionKeyBinding: sessionKeyBinding(finished.sessionKey, attackerKey.jwk, loginAttemptId),
    });
    expect(result.statusCode).toBe(403);
    const failed = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', r.account.id)
      .where('event_type', '=', 'OPAQUE_LOGIN_FAILED')
      .executeTakeFirstOrThrow();
    expect(failed.payload).toMatchObject({ reason: 'BINDING' });
  });

  it('el intento es de la sesión de cuenta que lo empezó', async () => {
    const r = await ready();
    const { response, clientLoginState, key } = await start(r.browser, r.authSecret);
    const { loginAttemptId, loginResponse } = response.json<{ loginAttemptId: string; loginResponse: string }>();
    const finished = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: r.authSecret,
      keyStretching: OPAQUE_KEY_STRETCHING,
    });
    if (!finished) throw new Error('debía abrir');
    const otherDevice = env.wallet.newClient();
    await otherDevice.post('/api/v1/auth/login', { email: r.account.email, password: r.account.password });
    const stolen = await otherDevice.post('/api/v1/platform-sessions/opaque/finish', {
      loginAttemptId,
      finishLoginRequest: finished.finishLoginRequest,
      sessionKeyBinding: sessionKeyBinding(finished.sessionKey, key.jwk, loginAttemptId),
    });
    expect(stolen.statusCode).toBe(403);
  });

  it('sin wallet ACTIVE con registro ACTIVE: 409 WALLET_NOT_ACTIVE', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    expect((await start(browser, newAuthSecret())).response.statusCode).toBe(409);
    const { walletId } = await seedActiveWallet(env.db, {
      userId: account.id,
      platformId: env.wallet.config.platformId,
      status: 'CREATING',
    });
    await registerOpaque(env.wallet, env.db, {
      userId: account.id,
      walletId,
      authSecretHex: newAuthSecret(),
      activate: false,
    });
    const pending = await start(browser, newAuthSecret());
    expect(pending.response.statusCode).toBe(409);
    expect(pending.response.json()).toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
  });

  it('sólo en el listener de Wallet y sólo con sesión de cuenta', async () => {
    const recovery = env.recovery.newClient();
    const { startLoginRequest } = opaque.client.startLogin({ password: newAuthSecret() });
    expect(
      (
        await recovery.post('/api/v1/platform-sessions/opaque/start', {
          startLoginRequest,
          sessionPublicKey: newSessionKey().jwk,
        })
      ).statusCode,
    ).toBe(404);
    const anonymous = env.wallet.newClient();
    expect(
      (
        await anonymous.post('/api/v1/platform-sessions/opaque/start', {
          startLoginRequest,
          sessionPublicKey: newSessionKey().jwk,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('cada inicio es un intento de Password U: 5 por minuto por sesión (rate limit real)', async () => {
    const r = await ready();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await start(r.browser, newAuthSecret())).response.statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('rechaza claves públicas que no son P-256 válidas y mensajes OPAQUE malformados', async () => {
    const r = await ready();
    const { startLoginRequest } = opaque.client.startLogin({ password: r.authSecret });
    const notOnCurve = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) };
    const badKey = await r.browser.post('/api/v1/platform-sessions/opaque/start', {
      startLoginRequest,
      sessionPublicKey: notOnCurve,
    });
    expect(badKey.statusCode).toBe(400);
    const withPrivate = await r.browser.post('/api/v1/platform-sessions/opaque/start', {
      startLoginRequest,
      sessionPublicKey: { ...newSessionKey().jwk, d: 'A'.repeat(43) },
    });
    expect(withPrivate.statusCode).toBe(400);
    const badMessage = await r.browser.post('/api/v1/platform-sessions/opaque/start', {
      startLoginRequest: 'A'.repeat(40),
      sessionPublicKey: newSessionKey().jwk,
    });
    expect(badMessage.statusCode).toBe(400);
  });
});
