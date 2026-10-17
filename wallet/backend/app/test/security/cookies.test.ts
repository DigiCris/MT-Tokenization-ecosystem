// P09.TST.f [B-AUTH-04/05]: atributos de las cookies (`__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/, sin
// Domain) en cada flujo que las fija o las borra, sólo sha256(token) en la base, y la API nunca devuelve tokens de
// sesión en el cuerpo ni en otros headers.
import { createHash } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { Secret as OtpSecret } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_MS } from '../../src/auth/sessions.ts';
import { totpCode } from '../../src/auth/totp.ts';
import { createVerifiedUser, randomEmail, randomPassword } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { setCookies, type ParsedCookie, type TestClient } from '../helpers/client.ts';
import { codeFrom, waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.cookies });
});
afterAll(async () => {
  await env.close();
});

function expectHostCookie(cookie: ParsedCookie | undefined, name: string): asserts cookie is ParsedCookie {
  expect(cookie, name).toBeDefined();
  if (!cookie) return;
  expect(cookie.name).toBe(name);
  expect(cookie.name.startsWith('__Host-')).toBe(true);
  expect(cookie.attributes.httponly).toBe(true);
  expect(cookie.attributes.secure).toBe(true);
  expect(cookie.attributes.samesite).toBe('Strict');
  expect(cookie.attributes.path).toBe('/');
  expect(cookie.attributes.domain).toBeUndefined();
}

const cookieNamed = (response: LightMyRequestResponse, name: string) =>
  setCookies(response).find((c) => c.name === name);
/** Token en claro de la cookie firmada (`<token>.<firma>`). */
const rawToken = (cookie: ParsedCookie) => {
  const value = decodeURIComponent(cookie.value);
  return value.slice(0, value.lastIndexOf('.'));
};

describe('atributos', () => {
  it('sesión de Wallet: __Host-mtw_sid con todos los atributos y Max-Age de la vida absoluta', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    const response = await browser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const cookie = cookieNamed(response, '__Host-mtw_sid');
    expectHostCookie(cookie, '__Host-mtw_sid');
    const maxAge = Number(cookie.attributes['max-age']);
    expect(maxAge).toBeGreaterThan(SESSION_ABSOLUTE_MS / 1000 - 60);
    expect(maxAge).toBeLessThanOrEqual(SESSION_ABSOLUTE_MS / 1000);
    expect(decodeURIComponent(cookie.value)).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9+/_-]{20,}$/);
  });

  it('sesión de Recovery: __Host-mtr_sid', async () => {
    const account = await createVerifiedUser(env.recovery, env.db);
    const response = await env.recovery
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    expectHostCookie(cookieNamed(response, '__Host-mtr_sid'), '__Host-mtr_sid');
    expect(cookieNamed(response, '__Host-mtw_sid')).toBeUndefined();
  });

  it('cookie anónima de CSRF: __Host-mtw_csrf / __Host-mtr_csrf con 2 h de vida', async () => {
    for (const [listener, name] of [
      [env.wallet, '__Host-mtw_csrf'],
      [env.recovery, '__Host-mtr_csrf'],
    ] as const) {
      const response = await listener.app.inject({
        method: 'GET',
        url: '/api/v1/auth/csrf',
        headers: { origin: listener.origin },
      });
      const cookie = cookieNamed(response, name);
      expectHostCookie(cookie, name);
      expect(cookie.attributes['max-age']).toBe('7200');
    }
  });

  it('borrar la cookie (logout) repite los atributos `__Host-` (si no, el navegador no la borra)', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    await browser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const response = await browser.post('/api/v1/auth/logout', {});
    const cleared = cookieNamed(response, '__Host-mtw_sid');
    expectHostCookie(cleared, '__Host-mtw_sid');
    expect(cleared.value).toBe('');
    expect(String(cleared.attributes.expires)).toContain('1970');
  });

  it('la base guarda sólo sha256(token)', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const response = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    const cookie = cookieNamed(response, '__Host-mtw_sid');
    expectHostCookie(cookie, '__Host-mtw_sid');
    const token = rawToken(cookie);
    const rows = await env.db.app.selectFrom('sessions').selectAll().where('user_id', '=', account.id).execute();
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.token_hash ?? []).equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('ningún token de sesión fuera de Set-Cookie', () => {
  it('registro, verificación, login, TOTP, perfil, sesiones, CSRF y logout', async () => {
    const responses: LightMyRequestResponse[] = [];
    const tokens = new Set<string>();
    const record = (response: LightMyRequestResponse) => {
      responses.push(response);
      for (const cookie of setCookies(response)) {
        if (cookie.name.endsWith('_sid') && cookie.value !== '') tokens.add(rawToken(cookie));
      }
      return response;
    };
    const call = async (
      browser: TestClient,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      body?: unknown,
    ) => record(await browser.request(method, url, body));

    const email = randomEmail('tokens');
    const password = randomPassword();
    const browser = env.wallet.newClient();
    await call(browser, 'GET', '/api/v1/auth/csrf');
    await call(browser, 'POST', '/api/v1/auth/register', { email, password });
    const code = codeFrom(await waitForMessage(email, (m) => m.subject.includes('Verificá tu email')));
    await call(browser, 'POST', '/api/v1/auth/verify-email', { email, code });
    await call(browser, 'GET', '/api/v1/users/me');
    await call(browser, 'PATCH', '/api/v1/users/me', { locale: 'en-US' });
    await call(browser, 'GET', '/api/v1/sessions');
    await call(browser, 'GET', '/api/v1/auth/csrf');
    const setup = await call(browser, 'POST', '/api/v1/auth/totp/setup', {});
    const secret = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    const enabled = await call(browser, 'POST', '/api/v1/auth/totp/enable', { code: totpCode(secret) });
    const second = env.wallet.newClient();
    await call(second, 'POST', '/api/v1/auth/login', { email, password, totp: totpCode(secret, Date.now() + 30_000) });
    // El paso siguiente ya lo usó el login: la desactivación va con un código de recuperación.
    const [recoveryCode] = enabled.json<{ recoveryCodes: string[] }>().recoveryCodes;
    await call(browser, 'POST', '/api/v1/auth/totp/disable', { password, recoveryCode });
    await call(browser, 'DELETE', '/api/v1/sessions');
    await call(browser, 'POST', '/api/v1/auth/logout', {});

    // Verificación, activación y desactivación de TOTP (rotan) y el login del segundo dispositivo.
    expect(responses.every((r) => r.statusCode < 400)).toBe(true);
    expect(tokens.size).toBe(4);
    for (const response of responses) {
      const otherHeaders = JSON.stringify(
        Object.fromEntries(Object.entries(response.headers).filter(([h]) => h !== 'set-cookie')),
      );
      for (const token of tokens) {
        expect(response.body).not.toContain(token);
        expect(response.body).not.toContain(encodeURIComponent(token));
        expect(otherHeaders).not.toContain(token);
      }
    }
    for (const response of responses.filter((r) => r.statusCode < 300 && r.body !== '')) {
      const json = response.json<Record<string, unknown>>();
      expect(Object.keys(json)).not.toContain('token');
      expect(Object.keys(json)).not.toContain('sessionToken');
    }
  });
});
