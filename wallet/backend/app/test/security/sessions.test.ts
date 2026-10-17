// P09.TST.b [B-AUTH-04/06]: sesión vencida por inactividad (30 min) o absoluta (12 h), sesión revocada, logout que
// invalida la sesión y sus PlatformSessions, y cookies adulteradas, sin firma o fijadas antes del login.
import { randomBytes } from 'node:crypto';
import { sign } from '@fastify/cookie';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_IDLE_MS } from '../../src/auth/sessions.ts';
import { createVerifiedUser, signedInClient } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { parseSetCookie, type TestClient } from '../helpers/client.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.securitySessions });
});
afterAll(async () => {
  await env.close();
});

async function sessionIdOf(browser: TestClient): Promise<string> {
  const response = await browser.get('/api/v1/sessions');
  const current = response.json<{ sessions: { id: string; current: boolean }[] }>().sessions.find((s) => s.current);
  if (!current) throw new Error('sin sesión');
  return current.id;
}

/** El request devuelve 401 y borra la cookie de sesión. */
async function expectRejected(browser: TestClient) {
  const response = await browser.get('/api/v1/users/me');
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  const cleared = (
    Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie']
      : [response.headers['set-cookie'] ?? '']
  )
    .map((c) => parseSetCookie(c))
    .find((c) => c.name === '__Host-mtw_sid');
  expect(cleared?.value).toBe('');
  expect(String(cleared?.attributes.expires)).toContain('1970');
}

describe('expiración', () => {
  it('por inactividad: pasados 30 min sin uso la sesión deja de valer y se borra la cookie', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const id = await sessionIdOf(browser);
    const row = await env.db.app
      .selectFrom('sessions')
      .select(['created_at', 'idle_expires_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Math.abs(row.idle_expires_at.getTime() - row.created_at.getTime() - SESSION_IDLE_MS)).toBeLessThan(5_000);
    await env.db.admin.query(`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await expectRejected(browser);
    // Ya sin cookie, el cliente queda anónimo.
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(401);
  });

  it('absoluta: a las 12 h vence aunque se use, y el deslizamiento nunca la supera', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const id = await sessionIdOf(browser);
    await env.db.admin.query(
      `UPDATE sessions SET last_seen_at = now() - interval '5 minutes', absolute_expires_at = now() + interval '2 minutes',
                            idle_expires_at = now() + interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
    const slid = await env.db.app
      .selectFrom('sessions')
      .select(['idle_expires_at', 'absolute_expires_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(slid.idle_expires_at.getTime()).toBe(slid.absolute_expires_at.getTime());

    await env.db.admin.query(
      `UPDATE sessions SET absolute_expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    await expectRejected(browser);
  });

  it('una sesión vencida no aparece en el listado de las demás', async () => {
    const { client: main, account } = await signedInClient(env.wallet, env.db);
    const other = env.wallet.newClient();
    await other.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const otherId = await sessionIdOf(other);
    await env.db.admin.query(`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`, [
      otherId,
    ]);
    const listed = await main.get('/api/v1/sessions');
    expect(listed.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id)).not.toContain(otherId);
  });
});

describe('revocación', () => {
  it('una sesión revocada (en la base) deja de valer al instante', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const id = await sessionIdOf(browser);
    await env.db.app
      .updateTable('sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: 'USER_REVOKED' })
      .where('id', '=', id)
      .execute();
    await expectRejected(browser);
  });

  it('logout: la cookie vieja reutilizada no sirve y sus PlatformSessions quedan revocadas', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const id = await sessionIdOf(browser);
    const platformIds: string[] = [];
    for (const scope of ['ONBOARDING', 'RECOVERY'] as const) {
      const row = await env.db.app
        .insertInto('platform_sessions')
        .values({
          account_session_id: id,
          user_id: account.id,
          scope,
          auth_method: 'STEP_UP',
          session_public_key_jwk: JSON.stringify({ kty: 'OKP' }),
          issued_at: sql`now()`,
          expires_at: sql`now() + interval '10 minutes'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      platformIds.push(row.id);
    }
    const cookie = browser.jar.get('__Host-mtw_sid') ?? '';
    expect((await browser.post('/api/v1/auth/logout', {})).statusCode).toBe(204);

    const replay = env.wallet.newClient();
    replay.jar.set('__Host-mtw_sid', cookie);
    await expectRejected(replay);
    const platforms = await env.db.app
      .selectFrom('platform_sessions')
      .select('revoked_at')
      .where('id', 'in', platformIds)
      .execute();
    expect(platforms.every((p) => p.revoked_at !== null)).toBe(true);
  });
});

describe('cookies adulteradas', () => {
  it('una firma inválida se descarta sin consultar la sesión', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const value = decodeURIComponent(browser.jar.get('__Host-mtw_sid') ?? '');
    const dot = value.lastIndexOf('.');
    const token = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}.${signature}`;
    for (const forged of [flipped, token, `${token}.`, `${token}.${'x'.repeat(signature.length)}`]) {
      const attacker = env.wallet.newClient();
      attacker.jar.set('__Host-mtw_sid', encodeURIComponent(forged));
      await expectRejected(attacker);
    }
    // La sesión legítima sigue intacta.
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
  });

  it('un token inexistente con firma válida (quien tuviera SESSION_SECRET) tampoco autentica', async () => {
    const secret = env.wallet.config.secrets.sessionSecret.reveal().toString('base64');
    const attacker = env.wallet.newClient();
    attacker.jar.set('__Host-mtw_sid', encodeURIComponent(sign(randomBytes(32).toString('base64url'), secret)));
    await expectRejected(attacker);
  });

  it('fijación de sesión: una cookie plantada antes del login nunca se adopta', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const secret = env.wallet.config.secrets.sessionSecret.reveal().toString('base64');
    const planted = encodeURIComponent(sign(randomBytes(32).toString('base64url'), secret));
    const victim = env.wallet.newClient();
    victim.jar.set('__Host-mtw_sid', planted);
    const login = await victim.post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(200);
    expect(victim.jar.get('__Host-mtw_sid')).not.toBe(planted);
    const attacker = env.wallet.newClient();
    attacker.jar.set('__Host-mtw_sid', planted);
    expect((await attacker.get('/api/v1/users/me')).statusCode).toBe(401);
  });
});
