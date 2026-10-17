// P09.T03 / P09.TST.c [B-AUTH-05]: todo método no seguro exige Origin exacto del listener, Content-Type JSON (si
// lleva cuerpo) y X-CSRF-Token = HMAC(CSRF_SECRET, sessionId) — o, sin sesión, atado al id anónimo de la cookie
// `__Host-` del listener. Y ninguna ruta arranca sin declarar su autenticación y sus errores de CSRF.
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { csrfToken } from '../../src/auth/csrf.ts';
import { createVerifiedUser, signedInClient } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { buildTestListener } from '../helpers/api.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.csrf });
});
afterAll(async () => {
  await env.close();
});

/** Request armado a mano (sin los automatismos del cliente de prueba). */
function raw(
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  url: string,
  headers: Record<string, string>,
  payload?: string,
  listener = env.wallet,
) {
  return listener.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: '203.0.113.77',
  });
}

describe('Origin', () => {
  it('un método no seguro sin Origin es 403 CSRF_ORIGIN_REQUIRED, con o sin sesión', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const anonymous = env.wallet.newClient();
    await anonymous.refreshCsrf();
    for (const client of [browser, anonymous]) {
      const response = await raw(
        'POST',
        '/api/v1/auth/logout',
        { cookie: client.cookieHeader, 'x-csrf-token': client.csrf ?? '', 'content-type': 'application/json' },
        '{}',
      );
      expect(response.statusCode).toBe(client === browser ? 403 : 401);
      if (client === browser) expect(response.json()).toMatchObject({ code: 'CSRF_ORIGIN_REQUIRED' });
    }
    const login = await raw(
      'POST',
      '/api/v1/auth/login',
      { cookie: anonymous.cookieHeader, 'x-csrf-token': anonymous.csrf ?? '', 'content-type': 'application/json' },
      JSON.stringify({ email: 'a@test.invalid', password: 'cualquier-password' }),
    );
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ code: 'CSRF_ORIGIN_REQUIRED' });
  });

  it('un Origin ajeno (o parecido) es 403 aunque el token CSRF sea válido', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const own = env.wallet.origin;
    for (const origin of [env.recovery.origin, 'https://evil.example', `${own}.evil.example`, `${own}0`, 'null']) {
      const response = await browser.post('/api/v1/auth/logout', {}, { origin });
      expect(response.statusCode, origin).toBe(403);
      expect(response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    }
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
  });
});

describe('X-CSRF-Token', () => {
  it('ausente o incorrecto: 403 CSRF_TOKEN_INVALID', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const headers = { origin: env.wallet.origin, cookie: browser.cookieHeader, 'content-type': 'application/json' };
    const missing = await raw('PATCH', '/api/v1/users/me', headers, JSON.stringify({ locale: 'en-US' }));
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
    const wrong = await raw(
      'PATCH',
      '/api/v1/users/me',
      { ...headers, 'x-csrf-token': 'A'.repeat(43) },
      JSON.stringify({ locale: 'en-US' }),
    );
    expect(wrong.statusCode).toBe(403);
    const truncated = await raw(
      'PATCH',
      '/api/v1/users/me',
      { ...headers, 'x-csrf-token': (browser.csrf ?? '').slice(0, 20) },
      JSON.stringify({ locale: 'en-US' }),
    );
    expect(truncated.statusCode).toBe(403);
    const row = await env.db.app
      .selectFrom('users')
      .select('locale')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.locale).toBe('es-AR');
  });

  it('el token está atado a la sesión: el de otra sesión no sirve; el de la propia es HMAC(CSRF_SECRET, sessionId)', async () => {
    const { client: alice } = await signedInClient(env.wallet, env.db);
    const { client: bob } = await signedInClient(env.wallet, env.db);
    const stolen = await alice.patch('/api/v1/users/me', { locale: 'en-US' }, { 'x-csrf-token': bob.csrf ?? '' });
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });

    const sessions = await alice.get('/api/v1/sessions');
    const current = sessions.json<{ sessions: { id: string; current: boolean }[] }>().sessions.find((s) => s.current);
    const expected = csrfToken(env.wallet.config.secrets.csrfSecret, { kind: 'session', sessionId: current?.id ?? '' });
    expect(alice.csrf).toBe(expected);
    const refreshed = await alice.get('/api/v1/auth/csrf');
    expect(refreshed.json()).toEqual({ csrfToken: expected });
    expect((await alice.patch('/api/v1/users/me', { locale: 'en-US' })).statusCode).toBe(200);
  });

  it('el token anónimo deja de servir al iniciar sesión y el de una sesión rotada también', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    const anonymousToken = await browser.refreshCsrf();
    const login = await browser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(200);
    const sessionToken = browser.csrf ?? '';
    expect(sessionToken).not.toBe(anonymousToken);
    expect(
      (await browser.patch('/api/v1/users/me', { locale: 'en-US' }, { 'x-csrf-token': anonymousToken })).statusCode,
    ).toBe(403);

    // Login de nuevo (rotación): el token de la sesión anterior queda inválido.
    await browser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(browser.csrf).not.toBe(sessionToken);
    expect(
      (await browser.patch('/api/v1/users/me', { locale: 'en-US' }, { 'x-csrf-token': sessionToken })).statusCode,
    ).toBe(403);
    expect((await browser.patch('/api/v1/users/me', { locale: 'en-US' })).statusCode).toBe(200);
  });

  it('sin sesión: el token anónimo exige su cookie firmada del mismo listener', async () => {
    const browser = env.wallet.newClient();
    const token = await browser.refreshCsrf();
    const anonCookie = browser.jar.get('__Host-mtw_csrf') ?? '';
    const body = JSON.stringify({ email: 'nadie@test.invalid' });
    const base = { origin: env.wallet.origin, 'content-type': 'application/json', 'x-csrf-token': token };
    const ok = await raw(
      'POST',
      '/api/v1/auth/forgot-password',
      { ...base, cookie: `__Host-mtw_csrf=${anonCookie}` },
      body,
    );
    expect(ok.statusCode).toBe(202);
    const noCookie = await raw('POST', '/api/v1/auth/forgot-password', base, body);
    expect(noCookie.statusCode).toBe(403);
    const [id] = decodeURIComponent(anonCookie).split('.');
    const forged = await raw(
      'POST',
      '/api/v1/auth/forgot-password',
      { ...base, cookie: `__Host-mtw_csrf=${id ?? ''}.firma-falsa` },
      body,
    );
    expect(forged.statusCode).toBe(403);
    // El token y la cookie del listener de Wallet no sirven en el de Recovery.
    const crossListener = await raw(
      'POST',
      '/api/v1/auth/forgot-password',
      { ...base, origin: env.recovery.origin, cookie: `__Host-mtw_csrf=${anonCookie}` },
      body,
      env.recovery,
    );
    expect(crossListener.statusCode).toBe(403);
    expect(crossListener.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
  });

  it('los métodos seguros no piden token y nunca cambian estado', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const response = await raw('GET', '/api/v1/users/me', { origin: env.wallet.origin, cookie: browser.cookieHeader });
    expect(response.statusCode).toBe(200);
  });
});

describe('Content-Type', () => {
  it('sólo JSON: text/plain, formulario y multipart son 415 antes de tocar el estado', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const headers = { origin: env.wallet.origin, cookie: browser.cookieHeader, 'x-csrf-token': browser.csrf ?? '' };
    for (const [type, payload] of [
      ['text/plain', '{"locale":"en-US"}'],
      ['application/x-www-form-urlencoded', 'locale=en-US'],
      ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="locale"\r\n\r\nen-US\r\n--x--'],
      ['application/json-patch+json', '[]'],
    ] as const) {
      const response = await raw('PATCH', '/api/v1/users/me', { ...headers, 'content-type': type }, payload);
      expect(response.statusCode, type).toBe(415);
      expect(response.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    const row = await env.db.app
      .selectFrom('users')
      .select('locale')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.locale).toBe('es-AR');
  });

  it('un POST sin cuerpo ni Content-Type también es 415; con charset es válido', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const headers = { origin: env.wallet.origin, cookie: browser.cookieHeader, 'x-csrf-token': browser.csrf ?? '' };
    const empty = await raw('POST', '/api/v1/auth/totp/setup', headers);
    expect(empty.statusCode).toBe(415);
    const withCharset = await raw(
      'POST',
      '/api/v1/auth/totp/setup',
      { ...headers, 'content-type': 'application/json; charset=utf-8' },
      '{}',
    );
    expect(withCharset.statusCode).toBe(200);
  });

  it('DELETE sin cuerpo no necesita Content-Type (sí Origin y token); con un cuerpo no JSON es 415', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const headers = { origin: env.wallet.origin, cookie: browser.cookieHeader, 'x-csrf-token': browser.csrf ?? '' };
    const textBody = await raw('DELETE', '/api/v1/sessions', { ...headers, 'content-type': 'text/plain' }, 'x');
    expect(textBody.statusCode).toBe(415);
    const noToken = await raw('DELETE', '/api/v1/sessions', {
      origin: env.wallet.origin,
      cookie: browser.cookieHeader,
    });
    expect(noToken.statusCode).toBe(403);
    const ok = await raw('DELETE', '/api/v1/sessions', headers);
    expect(ok.statusCode).toBe(200);
  });
});

describe('configuración de rutas', () => {
  const build = (register: RouteRegistrar) =>
    buildTestListener({ db: env.db, redis: env.redis, extraRoutes: register });

  it('una ruta sin config.auth no arranca', async () => {
    await expect(
      build((app) => {
        app.post(
          '/test/sin-auth',
          {
            schema: {
              operationId: 'testSinAuth',
              tags: ['test'],
              summary: 'Sin auth',
              body: z.object({}),
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses(403, 415) },
            },
          },
          () => ({ ok: true }),
        );
      }),
    ).rejects.toThrow(/ruta sin config.auth \('public' \| 'account'\): POST \/api\/v1\/test\/sin-auth/);
  });

  it('una ruta de cuenta sin 401 documentado, o no segura sin 403/415, no arranca', async () => {
    await expect(
      build((app) => {
        app.get(
          '/test/cuenta',
          {
            config: { auth: 'account' },
            schema: {
              operationId: 'testCuenta',
              tags: ['test'],
              summary: 'Cuenta',
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
            },
          },
          () => ({ ok: true }),
        );
      }),
    ).rejects.toThrow(/ruta sin documentar las respuestas 401: GET \/api\/v1\/test\/cuenta/);
    await expect(
      build((app) => {
        app.post(
          '/test/publica',
          {
            config: { auth: 'public' },
            schema: {
              operationId: 'testPublica',
              tags: ['test'],
              summary: 'Pública',
              body: z.object({}),
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
            },
          },
          () => ({ ok: true }),
        );
      }),
    ).rejects.toThrow(/ruta sin documentar las respuestas 403, 415: POST \/api\/v1\/test\/publica/);
  });

  it('csrf: false (relay firmado, reportes CSP) exime del token pero no del CORS', async () => {
    const listener = await build((app) => {
      app.post(
        '/test/relay',
        {
          config: { auth: 'public', csrf: false },
          schema: {
            operationId: 'testRelay',
            tags: ['test'],
            summary: 'Relay con su propia firma',
            body: z.object({ signature: z.string() }),
            response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
          },
        },
        () => ({ ok: true }),
      );
    });
    try {
      const ok = await listener.app.inject({
        method: 'POST',
        url: '/api/v1/test/relay',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ signature: '0x' }),
      });
      expect(ok.statusCode).toBe(200);
      const evil = await listener.app.inject({
        method: 'POST',
        url: '/api/v1/test/relay',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        payload: JSON.stringify({ signature: '0x' }),
      });
      expect(evil.statusCode).toBe(403);
    } finally {
      await listener.close();
    }
  });
});
