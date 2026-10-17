// P10.T05 [B-PSES-04], [B-AUTHZ]: el plugin valida el token del header X-Platform-Session (firma, emisor, vigencia,
// fila no revocada, sesión de cuenta padre) y el scope de cada ruta. Revocar, cerrar sesión o restablecer la contraseña
// invalidan la PlatformSession; un step-up nunca opera; un token no sirve con otra cuenta ni en otro listener.
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { Secret } from '../../src/config/secret.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { PlatformSessionIssuer } from '../../src/platform-session/token.ts';
import { signedInClient, type TestAccount } from '../helpers/accounts.ts';
import { buildTestListener, testRedis, type TestListener } from '../helpers/api.ts';
import type { TestClient } from '../helpers/client.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { resetTokenFrom, waitForMessage } from '../helpers/mailpit.ts';
import { startEmailPipeline, type EmailPipeline } from '../helpers/email-pipeline.ts';
import {
  checkSession,
  newAuthSecret,
  newSessionKey,
  registerOpaque,
  seedActiveWallet,
  signedHeaders,
  unlockWallet,
  type UnlockedSession,
} from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

/** Ruta crítica de prueba que sólo acepta OPERATIONS (como send/swap/whitelist de las fases siguientes). */
const operationsRoute: RouteRegistrar = (app) => {
  app.post(
    '/test/operate',
    {
      config: { auth: 'account', platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'testOperate',
        tags: ['test'],
        summary: 'Operación crítica de prueba',
        body: z.object({ amount: z.string() }),
        response: {
          200: z.object({ walletId: z.string().nullable(), scope: z.string() }),
          ...errorResponses(401, 403, 415),
        },
      },
    },
    (request) => ({
      walletId: request.platformSession?.claims.walletId ?? null,
      scope: request.platformSession?.claims.scope ?? '',
    }),
  );
};

let db: TestDatabase;
let wallet: TestListener;
let recovery: TestListener;
let pipeline: EmailPipeline;

beforeAll(async () => {
  db = await createTestDatabase();
  const redis = testRedis(REDIS_DBS.tokenScopes);
  await redis.flushdb();
  const config = testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000' });
  wallet = await buildTestListener({ db, client: 'WALLET', config, redis, extraRoutes: operationsRoute });
  recovery = await buildTestListener({ db, client: 'RECOVERY', config, redis });
  pipeline = await startEmailPipeline({
    db: db.app,
    redisDb: REDIS_DBS.tokenScopes,
    fieldKey: config.secrets.fieldEncryptionKey,
  });
});
afterAll(async () => {
  await pipeline.stop();
  await wallet.close();
  await recovery.close();
  await wallet.redis.quit();
  await db.close();
});

interface Unlocked {
  browser: TestClient;
  account: TestAccount;
  walletId: string;
  unlocked: UnlockedSession;
}

async function unlocked(): Promise<Unlocked> {
  const { client: browser, account } = await signedInClient(wallet, db);
  const { walletId } = await seedActiveWallet(db, { userId: account.id, platformId: wallet.config.platformId });
  const authSecret = newAuthSecret();
  await registerOpaque(wallet, db, { userId: account.id, walletId, authSecretHex: authSecret });
  return { browser, account, walletId, unlocked: await unlockWallet(browser, authSecret) };
}

const operate = (
  browser: TestClient,
  session: Pick<UnlockedSession, 'token' | 'sessionId' | 'key'>,
  body = '{"amount":"1"}',
) =>
  browser.post(
    '/api/v1/test/operate',
    JSON.parse(body) as unknown,
    signedHeaders({ ...session, method: 'POST', path: '/api/v1/test/operate', body }),
  );

describe('token de PlatformSession', () => {
  it('con token y firma válidos la ruta recibe la sesión verificada', async () => {
    const u = await unlocked();
    const response = await operate(u.browser, u.unlocked);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ walletId: u.walletId, scope: 'OPERATIONS' });
  });

  it('sin header: 403 PLATFORM_SESSION_REQUIRED; adulterado o de otro emisor: 403 PLATFORM_SESSION_INVALID', async () => {
    const u = await unlocked();
    const missing = await u.browser.post('/api/v1/test/operate', { amount: '1' });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'PLATFORM_SESSION_REQUIRED' });

    const [h, p, s] = u.unlocked.token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')),
        scope: 'OPERATIONS',
        walletId: crypto.randomUUID(),
      }),
    ).toString('base64url');
    for (const token of [
      `${h ?? ''}.${tamperedPayload}.${s ?? ''}`,
      `${h ?? ''}.${p ?? ''}.${'A'.repeat(86)}`,
      'no-es-un-jws',
    ]) {
      const r = await operate(u.browser, { ...u.unlocked, token });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    }
    // Firmado con otra clave Ed25519 (aunque copie el kid del emisor): inválido.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const forger = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, {
      kid: wallet.services.issuer.kid,
    });
    const claims = await wallet.services.issuer.verify(u.unlocked.token);
    const forged = await forger.sign(claims);
    expect((await operate(u.browser, { ...u.unlocked, token: forged })).json()).toMatchObject({
      code: 'PLATFORM_SESSION_INVALID',
    });
  });

  it('vencida (15 min) o fuera de la base: 403', async () => {
    const u = await unlocked();
    await db.admin.query(
      `UPDATE platform_sessions SET expires_at = now() - interval '1 second', issued_at = now() - interval '10 minutes' WHERE id = $1`,
      [u.unlocked.sessionId],
    );
    expect((await operate(u.browser, u.unlocked)).json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    // Un token bien firmado cuya fila no existe (el emisor es el único que podría fabricarlo).
    const v = await unlocked();
    const claims = await wallet.services.issuer.verify(v.unlocked.token);
    const orphan = await wallet.services.issuer.sign({ ...claims, sessionId: crypto.randomUUID() });
    expect(
      (await operate(v.browser, { ...v.unlocked, token: orphan, sessionId: claims.sessionId })).json(),
    ).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
  });

  it('revocar (DELETE /platform-sessions/:id) la invalida al instante; la de otro usuario es 404', async () => {
    const u = await unlocked();
    const other = await unlocked();
    expect((await u.browser.delete(`/api/v1/platform-sessions/${other.unlocked.sessionId}`)).statusCode).toBe(404);
    expect((await operate(other.browser, other.unlocked)).statusCode).toBe(200);
    expect((await u.browser.delete(`/api/v1/platform-sessions/${u.unlocked.sessionId}`)).statusCode).toBe(204);
    expect((await operate(u.browser, u.unlocked)).json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    expect((await u.browser.delete(`/api/v1/platform-sessions/${u.unlocked.sessionId}`)).statusCode).toBe(404);
  });

  it('logout revoca las PlatformSessions; un login nuevo no revive el token viejo', async () => {
    const u = await unlocked();
    expect((await u.browser.post('/api/v1/auth/logout', {})).statusCode).toBe(204);
    const row = await db.app
      .selectFrom('platform_sessions')
      .select('revoked_at')
      .where('id', '=', u.unlocked.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    await u.browser.post('/api/v1/auth/login', { email: u.account.email, password: u.account.password });
    expect((await operate(u.browser, u.unlocked)).json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
  });

  it('el reset de contraseña revoca todas las PlatformSessions', async () => {
    const u = await unlocked();
    await wallet.newClient().post('/api/v1/auth/forgot-password', { email: u.account.email });
    const token = resetTokenFrom(
      await waitForMessage(u.account.email, (m) => m.subject.includes('Restablecé tu contraseña')),
    );
    expect(
      (
        await wallet
          .newClient()
          .post('/api/v1/auth/reset-password', { token, newPassword: `Nueva-${crypto.randomUUID()}` })
      ).statusCode,
    ).toBe(204);
    const row = await db.app
      .selectFrom('platform_sessions')
      .select('revoked_at')
      .where('id', '=', u.unlocked.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });
});

describe('scope y autorización', () => {
  it('un step-up (ONBOARDING) intentando operar: 403 SCOPE_NOT_ALLOWED', async () => {
    const { client: browser, account } = await signedInClient(wallet, db);
    // PlatformSession ONBOARDING emitida por el servicio (como al terminar un step-up; el flujo por la API completo se
    // prueba en step-up.test.ts).
    const accountSession = await db.app
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', account.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    const key = newSessionKey();
    const result = await withTransaction(db.app, (trx) =>
      wallet.services.platformSessions.issue(trx, {
        userId: account.id,
        accountSessionId: accountSession.id,
        walletId: null,
        safe: null,
        scope: 'ONBOARDING',
        authMethod: 'STEP_UP',
        sessionPublicKey: key.jwk,
      }),
    );
    const issued = { token: result.token, sessionId: result.claims.sessionId, key };
    expect((await checkSession(browser, issued)).statusCode).toBe(200);
    const response = await operate(browser, issued);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('el token de otro usuario o de otra sesión de cuenta no sirve', async () => {
    const alice = await unlocked();
    const { client: bob } = await signedInClient(wallet, db);
    expect((await operate(bob, alice.unlocked)).json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    const aliceOtherDevice = wallet.newClient();
    await aliceOtherDevice.post('/api/v1/auth/login', { email: alice.account.email, password: alice.account.password });
    expect((await operate(aliceOtherDevice, alice.unlocked)).json()).toMatchObject({
      code: 'PLATFORM_SESSION_INVALID',
    });
  });

  it('una PlatformSession de Wallet no sirve en el listener de Recovery (su sesión de cuenta es otra)', async () => {
    const u = await unlocked();
    const recoveryBrowser = recovery.newClient();
    await recoveryBrowser.post('/api/v1/auth/login', { email: u.account.email, password: u.account.password });
    const response = await checkSession(recoveryBrowser, u.unlocked);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
  });

  it('una sesión de cuenta revocada arrastra a su PlatformSession aunque la fila no se haya tocado', async () => {
    const u = await unlocked();
    await db.app
      .updateTable('sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: 'USER_REVOKED' })
      .where('user_id', '=', u.account.id)
      .execute();
    expect((await operate(u.browser, u.unlocked)).statusCode).toBe(401);
  });
});

describe('configuración de rutas', () => {
  const build = (routes: RouteRegistrar) =>
    buildTestListener({ db, redis: testRedis(REDIS_DBS.tokenScopes), extraRoutes: routes });

  it('una ruta con PlatformSession pública, sin scopes o sin 403 documentado no arranca', async () => {
    const route =
      (config: Record<string, unknown>, statuses: number[]): RouteRegistrar =>
      (app) => {
        app.post(
          '/test/mal',
          {
            config: config as never,
            schema: {
              operationId: 'testMal',
              tags: ['test'],
              summary: 'Mal',
              body: z.object({}),
              response: { 200: z.object({}), ...errorResponses(...statuses) },
            },
          },
          () => ({}),
        );
      };
    await expect(
      build(route({ auth: 'public', platformSession: { scopes: ['OPERATIONS'] } }, [403, 415])),
    ).rejects.toThrow(/sin sesión de cuenta/);
    await expect(build(route({ auth: 'account', platformSession: { scopes: [] } }, [401, 403, 415]))).rejects.toThrow(
      /sin scopes/,
    );
  });
});
