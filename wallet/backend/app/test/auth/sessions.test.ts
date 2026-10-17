// P09.T02 [B-AUTH-03/04/06]: login, logout, rotación, listado de sesiones (dispositivo y última actividad),
// revocación individual y de todas las demás, sesión atada a su listener y preferencias del usuario.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_MS } from '../../src/auth/sessions.ts';
import { createVerifiedUser, signedInClient } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import type { TestClient } from '../helpers/client.ts';
import { waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.sessions });
});
afterAll(async () => {
  await env.close();
});

interface SessionView {
  id: string;
  client: 'WALLET' | 'RECOVERY';
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipPrefix: string | null;
  userAgent: string | null;
  current: boolean;
}

async function sessionsOf(browser: TestClient): Promise<SessionView[]> {
  const response = await browser.get('/api/v1/sessions');
  expect(response.statusCode).toBe(200);
  return response.json<{ sessions: SessionView[] }>().sessions;
}

async function currentSessionId(browser: TestClient): Promise<string> {
  const current = (await sessionsOf(browser)).find((s) => s.current);
  if (!current) throw new Error('sin sesión actual');
  return current.id;
}

async function addPlatformSession(sessionId: string, userId: string): Promise<string> {
  const row = await env.db.app
    .insertInto('platform_sessions')
    .values({
      account_session_id: sessionId,
      user_id: userId,
      scope: 'ONBOARDING',
      auth_method: 'STEP_UP',
      session_public_key_jwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'test' }),
      issued_at: sql`now()`,
      expires_at: sql`now() + interval '10 minutes'`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const platformRevoked = async (id: string) =>
  (await env.db.app.selectFrom('platform_sessions').select('revoked_at').where('id', '=', id).executeTakeFirstOrThrow())
    .revoked_at !== null;

describe('login', () => {
  it('abre una sesión con cookie, la lista con dispositivo y actividad y avisa por email', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    const response = await browser.post(
      '/api/v1/auth/login',
      { email: account.email, password: account.password },
      { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: account.id, email: account.email, emailVerified: true } });

    const [session, ...others] = await sessionsOf(browser);
    expect(others).toEqual([]);
    expect(session).toMatchObject({
      client: 'WALLET',
      current: true,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
      ipPrefix: `${browser.remoteAddress.split('.').slice(0, 3).join('.')}.0/24`,
    });
    const lifetime = Date.parse(session?.expiresAt ?? '') - Date.parse(session?.createdAt ?? '');
    expect(Math.abs(lifetime - SESSION_ABSOLUTE_MS)).toBeLessThan(5_000);

    const notice = await waitForMessage(account.email, (m) => m.subject.includes('Nuevo inicio de sesión'));
    expect(notice.text).toContain('Acción: Inicio de sesión');
    expect(notice.text).toContain('Firefox/140.0');
    expect(notice.text).toContain('Si no fuiste vos:');

    const row = await env.db.app
      .selectFrom('sessions')
      .select(['token_hash'])
      .where('id', '=', session?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toHaveLength(32);
  });

  it('credenciales incorrectas: 401 sin cookie de sesión', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    const response = await browser.post('/api/v1/auth/login', {
      email: account.email,
      password: `${account.password}!`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(browser.jar.has('__Host-mtw_sid')).toBe(false);
  });

  it('rotación: un login con sesión vigente revoca la anterior y encadena la nueva', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const previousId = await currentSessionId(browser);
    const previousCookie = browser.jar.get('__Host-mtw_sid') ?? '';

    expect(
      (await browser.post('/api/v1/auth/login', { email: account.email, password: account.password })).statusCode,
    ).toBe(200);
    const nextId = await currentSessionId(browser);
    expect(nextId).not.toBe(previousId);
    const rows = await env.db.app
      .selectFrom('sessions')
      .select(['id', 'revoke_reason', 'rotated_from_id'])
      .where('user_id', '=', account.id)
      .execute();
    expect(rows.find((r) => r.id === previousId)?.revoke_reason).toBe('ROTATED');
    expect(rows.find((r) => r.id === nextId)?.rotated_from_id).toBe(previousId);

    const stale = env.wallet.newClient();
    stale.jar.set('__Host-mtw_sid', previousCookie);
    expect((await stale.get('/api/v1/users/me')).statusCode).toBe(401);
  });

  it('la inactividad se desliza con el uso (como mucho una escritura por minuto)', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const id = await currentSessionId(browser);
    await env.db.admin.query(
      `UPDATE sessions SET last_seen_at = now() - interval '5 minutes', idle_expires_at = now() + interval '25 minutes' WHERE id = $1`,
      [id],
    );
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
    const slid = await env.db.app
      .selectFrom('sessions')
      .select(['last_seen_at', 'idle_expires_at', 'absolute_expires_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Date.now() - slid.last_seen_at.getTime()).toBeLessThan(10_000);
    expect(slid.idle_expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(slid.idle_expires_at.getTime()).toBeLessThanOrEqual(slid.absolute_expires_at.getTime());
    // Un segundo request dentro del mismo minuto no vuelve a escribir.
    await browser.get('/api/v1/users/me');
    const same = await env.db.app
      .selectFrom('sessions')
      .select('last_seen_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(same.last_seen_at.getTime()).toBe(slid.last_seen_at.getTime());
    expect(account.id).toBeTruthy();
  });
});

describe('sesiones', () => {
  it('lista las sesiones de todos los dispositivos y revoca una (con sus PlatformSessions)', async () => {
    const { client: laptop, account } = await signedInClient(env.wallet, env.db);
    const phone = env.wallet.newClient();
    await phone.post(
      '/api/v1/auth/login',
      { email: account.email, password: account.password },
      { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)' },
    );
    const phoneId = await currentSessionId(phone);
    const platform = await addPlatformSession(phoneId, account.id);

    const listed = await sessionsOf(laptop);
    expect(listed).toHaveLength(2);
    expect(listed.filter((s) => s.current)).toHaveLength(1);
    expect(listed.find((s) => s.id === phoneId)?.userAgent).toContain('iPhone');

    const revoked = await laptop.delete(`/api/v1/sessions/${phoneId}`);
    expect(revoked.statusCode).toBe(204);
    expect(revoked.headers['set-cookie']).toBeUndefined();
    expect((await phone.get('/api/v1/users/me')).statusCode).toBe(401);
    expect(phone.jar.has('__Host-mtw_sid')).toBe(false);
    expect(await platformRevoked(platform)).toBe(true);
    expect(await sessionsOf(laptop)).toHaveLength(1);
    expect((await laptop.delete(`/api/v1/sessions/${phoneId}`)).statusCode).toBe(404);

    const audit = await env.db.app
      .selectFrom('audit_events')
      .select(['event_type', 'payload'])
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'SESSION_REVOKED')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ revokedSessionId: phoneId });
  });

  it('revocar la sesión actual borra la cookie', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const id = await currentSessionId(browser);
    const response = await browser.delete(`/api/v1/sessions/${id}`);
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/__Host-mtw_sid=;.*Expires=Thu, 01 Jan 1970/);
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(401);
  });

  it('revoca todas las demás sesiones y conserva la actual', async () => {
    const { client: main, account } = await signedInClient(env.wallet, env.db);
    const others: TestClient[] = [];
    for (let i = 0; i < 3; i++) {
      const other = env.wallet.newClient();
      await other.post('/api/v1/auth/login', { email: account.email, password: account.password });
      others.push(other);
    }
    const otherPlatform = await addPlatformSession(await currentSessionId(others[0]!), account.id);
    const mainPlatform = await addPlatformSession(await currentSessionId(main), account.id);

    const response = await main.delete('/api/v1/sessions');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 3 });
    for (const other of others) expect((await other.get('/api/v1/users/me')).statusCode).toBe(401);
    expect((await main.get('/api/v1/users/me')).statusCode).toBe(200);
    expect(await platformRevoked(otherPlatform)).toBe(true);
    expect(await platformRevoked(mainPlatform)).toBe(false);
  });

  it('una sesión de otro usuario responde 404 y no se toca ([B-AUTHZ])', async () => {
    const { client: alice } = await signedInClient(env.wallet, env.db);
    const { client: bob } = await signedInClient(env.wallet, env.db);
    const bobSession = await currentSessionId(bob);
    const response = await alice.delete(`/api/v1/sessions/${bobSession}`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await bob.get('/api/v1/users/me')).statusCode).toBe(200);
    expect((await alice.delete(`/api/v1/sessions/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await alice.delete('/api/v1/sessions/no-es-uuid')).statusCode).toBe(400);
  });

  it('la sesión vale sólo en el listener que la creó', async () => {
    const { client: walletBrowser } = await signedInClient(env.wallet, env.db);
    const token = walletBrowser.jar.get('__Host-mtw_sid') ?? '';
    const recoveryBrowser = env.recovery.newClient();
    recoveryBrowser.jar.set('__Host-mtw_sid', token);
    expect((await recoveryBrowser.get('/api/v1/users/me')).statusCode).toBe(401);
    // Ni renombrando la cookie a la del listener de Recovery (la firma es válida, el listener no).
    const renamed = env.recovery.newClient();
    renamed.jar.set('__Host-mtr_sid', token);
    expect((await renamed.get('/api/v1/users/me')).statusCode).toBe(401);
    expect((await walletBrowser.get('/api/v1/users/me')).statusCode).toBe(200);
  });

  it('una cuenta deshabilitada pierde sus sesiones al instante', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ status: 'DISABLED' }).where('id', '=', account.id).execute();
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(401);
    const login = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
});

describe('logout', () => {
  it('revoca la sesión y sus PlatformSessions, borra la cookie y queda auditado', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const id = await currentSessionId(browser);
    const platform = await addPlatformSession(id, account.id);
    const response = await browser.post('/api/v1/auth/logout', {});
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/__Host-mtw_sid=;/);
    expect(browser.jar.has('__Host-mtw_sid')).toBe(false);
    const row = await env.db.app
      .selectFrom('sessions')
      .select(['revoked_at', 'revoke_reason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.revoke_reason).toBe('LOGOUT');
    expect(await platformRevoked(platform)).toBe(true);
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(401);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('session_id', '=', id)
      .where('event_type', '=', 'AUTH_LOGOUT')
      .executeTakeFirst();
    expect(audit).toBeDefined();
  });

  it('sin sesión es 401', async () => {
    const response = await env.wallet.newClient().post('/api/v1/auth/logout', {});
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('preferencias del usuario', () => {
  it('actualiza locale y zona horaria; los emails siguientes las usan', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const updated = await browser.patch('/api/v1/users/me', {
      locale: 'en-US',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ locale: 'en-US', timeZone: 'America/Argentina/Buenos_Aires' });

    await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: account.password });
    const notice = await waitForMessage(
      account.email,
      (m) => m.subject.includes('Nuevo inicio de sesión') && m.text.includes('America/Argentina/Buenos_Aires'),
    );
    expect(notice.text).toMatch(/Fecha: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} \(America\/Argentina\/Buenos_Aires\)/);
    expect(notice.text).toMatch(/Fecha \(UTC\): .+ UTC/);
  });

  it('valida los valores y rechaza campos desconocidos o un patch vacío', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    for (const body of [{ timeZone: 'Marte/Olympus' }, { locale: 'español' }, {}, { email: 'otro@test.invalid' }]) {
      const response = await browser.patch('/api/v1/users/me', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('sin sesión, las rutas de cuenta responden 401', async () => {
    const anonymous = env.wallet.newClient();
    for (const response of [
      await anonymous.get('/api/v1/users/me'),
      await anonymous.get('/api/v1/sessions'),
      await anonymous.patch('/api/v1/users/me', { locale: 'es-AR' }),
      await anonymous.delete('/api/v1/sessions'),
    ]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });
});
