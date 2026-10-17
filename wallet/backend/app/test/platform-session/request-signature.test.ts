// P10.T06 [B-PSES-05]: requests críticos firmados con la session key, contra la API real. La firma cubre método, ruta,
// SHA-256 de los bytes exactos del cuerpo, timestamp (±60 s), nonce (único 5 min en Valkey) y sessionId; una firma
// inválida no consume el nonce del cliente legítimo.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { RequestNonceStore } from '../../src/platform-session/request-signature.ts';
import { signedInClient } from '../helpers/accounts.ts';
import { buildTestListener, testRedis, type TestListener } from '../helpers/api.ts';
import type { TestClient } from '../helpers/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import {
  newAuthSecret,
  newSessionKey,
  registerOpaque,
  seedActiveWallet,
  signedHeaders,
  unlockWallet,
  type UnlockedSession,
} from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let calls = 0;
const routes: RouteRegistrar = (app) => {
  app.post(
    '/test/transfer/:walletId',
    {
      config: { auth: 'account', platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'testTransfer',
        tags: ['test'],
        summary: 'Operación crítica de prueba con efecto',
        params: z.object({ walletId: z.uuid() }),
        querystring: z.object({ dryRun: z.enum(['0', '1']).optional() }),
        body: z.object({ amount: z.string(), destination: z.string() }),
        response: { 200: z.object({ ok: z.boolean() }), ...errorResponses(401, 403, 415) },
      },
    },
    () => {
      calls += 1;
      return { ok: true };
    },
  );
};

let db: TestDatabase;
let listener: TestListener;

beforeAll(async () => {
  db = await createTestDatabase();
  const redis = testRedis(REDIS_DBS.requestSignature);
  await redis.flushdb();
  listener = await buildTestListener({ db, redis, extraRoutes: routes });
});
afterAll(async () => {
  await listener.close();
  await listener.redis.quit();
  await db.close();
});

async function unlocked(): Promise<{ browser: TestClient; walletId: string; session: UnlockedSession }> {
  const { client: browser, account } = await signedInClient(listener, db);
  const { walletId } = await seedActiveWallet(db, { userId: account.id, platformId: listener.config.platformId });
  const authSecret = newAuthSecret();
  await registerOpaque(listener, db, { userId: account.id, walletId, authSecretHex: authSecret });
  return { browser, walletId, session: await unlockWallet(browser, authSecret) };
}

describe('firma de requests críticos', () => {
  it('con la firma correcta del cuerpo exacto (incluida la query) la operación se ejecuta', async () => {
    const u = await unlocked();
    const path = `/api/v1/test/transfer/${u.walletId}?dryRun=1`;
    // Cuerpo con un orden de claves y espacios propios: la firma cubre esos bytes, no un JSON re-serializado.
    const body = '{ "destination": "0x0000000000000000000000000000000000000001", "amount": "10" }';
    const before = calls;
    const response = await listener.app.inject({
      method: 'POST',
      url: path,
      headers: {
        origin: listener.origin,
        cookie: u.browser.cookieHeader,
        'x-csrf-token': u.browser.csrf ?? '',
        'content-type': 'application/json',
        ...signedHeaders({ ...u.session, method: 'POST', path, body }),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toBe(before + 1);
  });

  it('sin headers de firma, con otro cuerpo, otra ruta, otro método u otra session key: 403 y la operación no corre', async () => {
    const u = await unlocked();
    const path = `/api/v1/test/transfer/${u.walletId}`;
    const body = '{"amount":"10","destination":"0x1"}';
    const base = {
      origin: listener.origin,
      cookie: u.browser.cookieHeader,
      'x-csrf-token': u.browser.csrf ?? '',
      'content-type': 'application/json',
    };
    const inject = (headers: Record<string, string>, url = path, payload = body) =>
      listener.app.inject({ method: 'POST', url, headers: { ...base, ...headers }, payload });
    const before = calls;

    const onlyToken = await inject({ 'x-platform-session': u.session.token });
    expect(onlyToken.statusCode).toBe(403);
    expect(onlyToken.json()).toMatchObject({ code: 'REQUEST_SIGNATURE_INVALID' });

    const signed = signedHeaders({ ...u.session, method: 'POST', path, body });
    expect((await inject(signed, path, '{"amount":"99","destination":"0x1"}')).json()).toMatchObject({
      code: 'REQUEST_SIGNATURE_INVALID',
    });
    expect(
      (
        await inject(
          signedHeaders({ ...u.session, method: 'POST', path, body }),
          `/api/v1/test/transfer/${crypto.randomUUID()}`,
        )
      ).json(),
    ).toMatchObject({
      code: 'REQUEST_SIGNATURE_INVALID',
    });
    expect((await inject(signedHeaders({ ...u.session, method: 'PUT', path, body }))).json()).toMatchObject({
      code: 'REQUEST_SIGNATURE_INVALID',
    });
    expect(
      (await inject(signedHeaders({ ...u.session, key: newSessionKey(), method: 'POST', path, body }))).json(),
    ).toMatchObject({
      code: 'REQUEST_SIGNATURE_INVALID',
    });
    expect((await inject({ ...signed, 'x-session-signature': 'A'.repeat(86) })).statusCode).toBe(403);
    expect((await inject({ ...signed, 'x-session-nonce': 'no-hex' })).statusCode).toBe(403);
    expect(calls).toBe(before);
  });

  it('timestamp fuera de ±60 s: 403 REQUEST_EXPIRED', async () => {
    const u = await unlocked();
    const path = `/api/v1/test/transfer/${u.walletId}`;
    const body = '{"amount":"1","destination":"0x1"}';
    const base = {
      origin: listener.origin,
      cookie: u.browser.cookieHeader,
      'x-csrf-token': u.browser.csrf ?? '',
      'content-type': 'application/json',
    };
    const now = Math.floor(Date.now() / 1000);
    for (const timestamp of [now - 61, now + 61]) {
      const r = await listener.app.inject({
        method: 'POST',
        url: path,
        headers: { ...base, ...signedHeaders({ ...u.session, method: 'POST', path, body, timestamp }) },
        payload: body,
      });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: 'REQUEST_EXPIRED' });
    }
    const edge = await listener.app.inject({
      method: 'POST',
      url: path,
      headers: { ...base, ...signedHeaders({ ...u.session, method: 'POST', path, body, timestamp: now - 55 }) },
      payload: body,
    });
    expect(edge.statusCode).toBe(200);
  });

  it('nonce repetido: 403 REQUEST_REPLAYED; una firma inválida no le quema el nonce al cliente legítimo', async () => {
    const u = await unlocked();
    const path = `/api/v1/test/transfer/${u.walletId}`;
    const body = '{"amount":"1","destination":"0x1"}';
    const base = {
      origin: listener.origin,
      cookie: u.browser.cookieHeader,
      'x-csrf-token': u.browser.csrf ?? '',
      'content-type': 'application/json',
    };
    const nonce = randomBytes(16).toString('hex');
    const headers = signedHeaders({ ...u.session, method: 'POST', path, body, nonce });
    // Un atacante con el nonce pero sin la clave no lo consume.
    const forged = await listener.app.inject({
      method: 'POST',
      url: path,
      headers: { ...base, ...headers, 'x-session-signature': 'B'.repeat(86) },
      payload: body,
    });
    expect(forged.statusCode).toBe(403);
    expect(
      (await listener.app.inject({ method: 'POST', url: path, headers: { ...base, ...headers }, payload: body }))
        .statusCode,
    ).toBe(200);
    const replay = await listener.app.inject({
      method: 'POST',
      url: path,
      headers: { ...base, ...headers },
      payload: body,
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toMatchObject({ code: 'REQUEST_REPLAYED' });
    const ttl = await listener.redis.ttl(`mtw:reqnonce:${u.session.sessionId}:${nonce}`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('el mismo nonce en otra PlatformSession es independiente', async () => {
    const store = new RequestNonceStore(listener.redis);
    const nonce = randomBytes(16).toString('hex');
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    expect(await store.claim(a, nonce)).toBe(true);
    expect(await store.claim(a, nonce)).toBe(false);
    expect(await store.claim(b, nonce)).toBe(true);
  });
});
