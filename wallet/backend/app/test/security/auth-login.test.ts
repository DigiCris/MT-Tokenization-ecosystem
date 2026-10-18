// P09.TST.a [B-AUTH-03]: credenciales inválidas y enumeración de usuarios. El login responde igual (status, cuerpo y
// headers) y con un tiempo equivalente (hash Argon2id dummy) para un email inexistente o una contraseña incorrecta,
// cualquiera sea el estado de la cuenta; registro, reenvío, olvido y pedido de desbloqueo responden igual exista o no.
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUser, randomEmail, randomPassword } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;
let ipCounter = 0;
/** Una IP distinta por intento (198.18.0.0/15, rango de benchmarking): los contadores por IP no interfieren. */
const freshIp = () => {
  ipCounter += 1;
  return `198.18.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
};

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.authLogin });
});
afterAll(async () => {
  await env.close();
});

function shape(response: LightMyRequestResponse) {
  const { requestId: _requestId, ...body } = response.json<Record<string, unknown>>();
  const headers = Object.keys(response.headers)
    .filter(
      (h) => !['x-request-id', 'date', 'content-length', 'x-ratelimit-remaining', 'x-ratelimit-reset'].includes(h),
    )
    .sort();
  return { status: response.statusCode, body, headers };
}

const login = (email: string, password: string) =>
  env.wallet.newClient(freshIp()).post('/api/v1/auth/login', { email, password });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

describe('login: respuesta uniforme', () => {
  it('email inexistente y contraseña incorrecta (activa, bloqueada, sin verificar, deshabilitada) responden igual', async () => {
    const [active, locked, unverified, disabled] = await Promise.all(
      [1, 2, 3, 4].map(() => createVerifiedUser(env.wallet, env.db)),
    );
    await env.db.app
      .updateTable('users')
      .set({ status: 'LOCKED' })
      .where('id', '=', locked?.id ?? '')
      .execute();
    await env.db.app
      .updateTable('users')
      .set({ email_verified_at: null })
      .where('id', '=', unverified?.id ?? '')
      .execute();
    await env.db.app
      .updateTable('users')
      .set({ status: 'DISABLED' })
      .where('id', '=', disabled?.id ?? '')
      .execute();

    const reference = shape(await login(randomEmail('nadie'), randomPassword()));
    expect(reference.status).toBe(401);
    expect(reference.body).toEqual({
      type: 'urn:mtw:problem:invalid-credentials',
      title: 'Email o contraseña incorrectos',
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    for (const account of [active, locked, unverified, disabled]) {
      const response = await login(account?.email ?? '', `${account?.password ?? ''}-mal`);
      expect(shape(response)).toEqual(reference);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('el tiempo de respuesta no distingue un email inexistente de una contraseña incorrecta', async () => {
    const rounds = 16;
    const accounts = await Promise.all(Array.from({ length: rounds }, () => createVerifiedUser(env.wallet, env.db)));
    // Calentamiento: el primer hash dummy se calcula una vez por proceso.
    await login(randomEmail('calentamiento'), randomPassword());
    await login(accounts[0]?.email ?? '', 'calentamiento-incorrecto');
    const unknown: number[] = [];
    const wrong: number[] = [];
    const timed = async (attempt: () => Promise<{ statusCode: number }>) => {
      const start = performance.now();
      expect((await attempt()).statusCode).toBe(401);
      return performance.now() - start;
    };
    for (let i = 0; i < rounds; i++) {
      const unknownAttempt = () => login(randomEmail('t'), randomPassword());
      const wrongAttempt = () => login(accounts[i]?.email ?? '', randomPassword());
      // Pares consecutivos con el orden alternado: los dos caminos ven la misma carga de la máquina.
      let u: number;
      let w: number;
      if (i % 2 === 0) {
        u = await timed(unknownAttempt);
        w = await timed(wrongAttempt);
      } else {
        w = await timed(wrongAttempt);
        u = await timed(unknownAttempt);
      }
      unknown.push(u);
      wrong.push(w);
    }
    // Los dos caminos pagan un Argon2id completo (m=64 MiB, t=3): sin él, el email inexistente respondería en una
    // fracción del tiempo. Un oráculo de tiempo es un sesgo entre los dos caminos: se comparan sus medianas (pares
    // intercalados, misma carga de la máquina); la dispersión de cada medición por sí sola no indica nada.
    const [mu, mw] = [median(unknown), median(wrong)];
    expect(Math.min(mu, mw)).toBeGreaterThan(20);
    expect(Math.abs(mu - mw) / Math.max(mu, mw)).toBeLessThan(0.25);
  });

  it('un email con otra capitalización o espacios es la misma cuenta (normalización antes de buscar)', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const response = await login(`  ${account.email.toUpperCase()}  `.trim(), account.password);
    expect(response.statusCode).toBe(200);
  });

  it('los fallos quedan auditados con el email enmascarado (nunca la contraseña) y en la métrica de fallos', async () => {
    const email = randomEmail('auditado');
    const password = randomPassword();
    const response = await login(email, password);
    const event = await env.db.app
      .selectFrom('audit_events')
      .select(['payload', 'user_id', 'event_type'])
      .where('request_id', '=', response.json<{ requestId: string }>().requestId)
      .executeTakeFirstOrThrow();
    expect(event.event_type).toBe('AUTH_LOGIN_FAILED');
    expect(event.user_id).toBeNull();
    expect(event.payload).toMatchObject({ reason: 'invalid_credentials', email: 'a***@test.invalid', failures: 1 });
    expect(JSON.stringify(event.payload)).not.toContain(password);
    expect(JSON.stringify(event.payload)).not.toContain(email);
    const metric = await env.wallet.metrics.registry.getSingleMetricAsString('mtw_auth_failures_total');
    expect(metric).toContain('reason="invalid_credentials"');
  });
});

describe('sin enumeración en los demás flujos', () => {
  it('registro, reenvío, olvido y desbloqueo responden igual para cuentas existentes e inexistentes', async () => {
    const verified = await createVerifiedUser(env.wallet, env.db);
    const unverified = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ email_verified_at: null }).where('id', '=', unverified.id).execute();
    const locked = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ status: 'LOCKED' }).where('id', '=', locked.id).execute();

    const cases: [string, (email: string) => Record<string, string>, string[]][] = [
      ['/api/v1/auth/register', (email) => ({ email, password: randomPassword() }), [verified.email, unverified.email]],
      ['/api/v1/auth/verify-email/resend', (email) => ({ email }), [verified.email, unverified.email]],
      ['/api/v1/auth/forgot-password', (email) => ({ email }), [verified.email, locked.email]],
      ['/api/v1/auth/unlock/request', (email) => ({ email }), [verified.email, locked.email]],
    ];
    for (const [url, body, existing] of cases) {
      const reference = shape(await env.wallet.newClient(freshIp()).post(url, body(randomEmail('nadie'))));
      expect(reference.status, url).toBe(202);
      for (const email of existing) {
        expect(shape(await env.wallet.newClient(freshIp()).post(url, body(email))), `${url} ${email}`).toEqual(
          reference,
        );
      }
    }
  });

  it('verificar o desbloquear con un código para un email inexistente es el mismo 400 que un código incorrecto', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ email_verified_at: null }).where('id', '=', account.id).execute();
    const browser = env.wallet.newClient(freshIp());
    for (const url of ['/api/v1/auth/verify-email', '/api/v1/auth/unlock']) {
      const unknown = shape(await browser.post(url, { email: randomEmail('nadie'), code: '12345678' }));
      const existing = shape(await browser.post(url, { email: account.email, code: '12345678' }));
      expect(unknown.status).toBe(400);
      expect(existing).toEqual(unknown);
    }
  });
});
