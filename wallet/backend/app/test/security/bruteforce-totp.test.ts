// P09.T05 / P09.TST.e [B-AUTH-08/09, B-RL]: fuerza bruta con los tiempos reales (sin adelantar relojes): contador por
// cuenta y por IP con espera exponencial desde el 5.º fallo, bloqueo blando al 10.º con desbloqueo por OTP del email,
// señales de credential stuffing (métrica + auditoría), rate limits reales de login y olvido, y TOTP sin replay ni
// fuerza bruta, con códigos de recuperación de un solo uso.
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightMyRequestResponse } from 'fastify';
import { Secret as OtpSecret } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THROTTLE } from '../../src/auth/risk.ts';
import { totpCode } from '../../src/auth/totp.ts';
import {
  createVerifiedUser,
  randomEmail,
  randomPassword,
  signedInClient,
  type TestAccount,
} from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { buildTestListener, testRedis } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { codeFrom, waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;
let ipCounter = 0;
/** IP nueva (198.18.0.0/15): aísla el contador por cuenta del contador por IP y de [B-RL]. */
const freshIp = () => {
  ipCounter += 1;
  return `198.19.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
};

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.bruteforceTotp });
});
afterAll(async () => {
  await env.close();
});

const login = (email: string, password: string, ip = freshIp(), extra: Record<string, string> = {}) =>
  env.wallet.newClient(ip).post('/api/v1/auth/login', { email, password, ...extra });

const retryAfter = (response: LightMyRequestResponse) => Number(response.headers['retry-after']);

/** Espera la penalidad informada por Retry-After (más un margen) antes del próximo intento. */
async function waitPenalty(response: LightMyRequestResponse): Promise<void> {
  await sleep(retryAfter(response) * 1000 + 150);
}

async function auditEvents(eventType: string, userId?: string) {
  let query = env.db.app
    .selectFrom('audit_events')
    .select(['payload', 'user_id', 'ip_prefix'])
    .where('event_type', '=', eventType);
  if (userId !== undefined) query = query.where('user_id', '=', userId);
  return query.orderBy('id').execute();
}

describe('fuerza bruta por cuenta', () => {
  it('espera exponencial desde el 5.º fallo, bloqueo blando al 10.º y desbloqueo con el OTP del email', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const wrong = () => login(account.email, `${account.password}-mal`);
    // Momento en que empezó el último fallo: la penalidad corre desde que el servidor lo registró (después).
    let lastFailureStart = performance.now();
    for (let i = 1; i <= THROTTLE.freeFailures; i++) {
      lastFailureStart = performance.now();
      expect((await wrong()).statusCode, `fallo ${String(i)}`).toBe(401);
    }

    // Desde el 5.º fallo: 1 s, 2 s, 4 s, 8 s, 16 s (el intento durante la espera es 429 y no cuenta).
    for (let failure = THROTTLE.freeFailures + 1; failure <= THROTTLE.softLockFailures; failure++) {
      const penalty = 2 ** (failure - 1 - THROTTLE.freeFailures);
      const attemptStart = performance.now();
      const blocked = await wrong();
      const blockedAt = performance.now();
      if (blocked.statusCode === 401) {
        // Con la máquina cargada el intento pudo procesarse cuando la espera ya había vencido (la de 1 s, sobre todo):
        // sólo vale si desde que empezó el fallo anterior pasó al menos la penalidad; si no, el servidor dejó pasar un
        // intento durante la espera. Ese intento es el fallo siguiente.
        expect(
          (blockedAt - lastFailureStart) / 1000,
          `fallo ${String(failure)} durante la espera`,
        ).toBeGreaterThanOrEqual(penalty);
        lastFailureStart = attemptStart;
        continue;
      }
      expect(blocked.statusCode, `espera antes del fallo ${String(failure)}`).toBe(429);
      // Retry-After es la espera restante (ceil del TTL): la penalidad exponencial menos lo que pudo transcurrir
      // desde que se registró el fallo anterior (acotado por la latencia medida acá).
      const elapsedSeconds = (blockedAt - lastFailureStart) / 1000;
      expect(retryAfter(blocked), `penalidad antes del fallo ${String(failure)}`).toBeLessThanOrEqual(penalty);
      expect(retryAfter(blocked)).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(penalty - elapsedSeconds)));
      // Ni la contraseña correcta pasa durante la espera (una vez: [B-RL] permite 20 intentos por hora por email); con
      // la de 4 s hay margen aunque la máquina esté cargada.
      if (penalty === 4) expect((await login(account.email, account.password)).statusCode).toBe(429);
      await waitPenalty(blocked);
      lastFailureStart = performance.now();
      expect((await wrong()).statusCode, `fallo ${String(failure)}`).toBe(401);
    }

    const user = await env.db.app
      .selectFrom('users')
      .select(['status', 'failed_login_count'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ status: 'LOCKED', failed_login_count: THROTTLE.softLockFailures });
    const locked = await auditEvents('AUTH_ACCOUNT_LOCKED', account.id);
    expect(locked).toHaveLength(1);
    expect(locked[0]?.payload).toMatchObject({ failures: THROTTLE.softLockFailures });

    const unlockEmail = await waitForMessage(account.email, (m) => m.subject.includes('Desbloqueá tu cuenta'));
    expect(unlockEmail.text).toContain('Hubo varios intentos de inicio de sesión con contraseña incorrecta');
    const unlocked = await env.wallet
      .newClient(freshIp())
      .post('/api/v1/auth/unlock', { email: account.email, code: codeFrom(unlockEmail) });
    expect(unlocked.statusCode).toBe(204);
    // El desbloqueo limpia el contador y la espera de la cuenta.
    expect((await login(account.email, account.password)).statusCode).toBe(200);
    const after = await env.db.app
      .selectFrom('users')
      .select(['status', 'failed_login_count'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'ACTIVE', failed_login_count: 0 });
  }, 120_000);

  it('una cuenta bloqueada con la contraseña correcta responde ACCOUNT_LOCKED y reenvía el código', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ status: 'LOCKED' }).where('id', '=', account.id).execute();
    const response = await login(account.email, account.password);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(response.headers['set-cookie']).toBeUndefined();
    const email = await waitForMessage(account.email, (m) => m.subject.includes('Desbloqueá tu cuenta'));
    expect(codeFrom(email)).toMatch(/^\d{8}$/);
  });

  it('un email inexistente tiene el mismo contador y la misma espera (sin enumeración)', async () => {
    const email = randomEmail('fantasma');
    let lastFailureStart = performance.now();
    for (let i = 0; i < THROTTLE.freeFailures; i++) {
      lastFailureStart = performance.now();
      expect((await login(email, randomPassword())).statusCode).toBe(401);
    }
    // La misma espera que una cuenta existente (1 s desde el 5.º fallo, después 2 s, …). Como en el test de la cuenta,
    // con la máquina cargada el intento pudo procesarse con la espera ya vencida: sólo vale si desde que empezó el fallo
    // anterior pasó al menos la penalidad, y ese intento es el fallo siguiente.
    for (let failure = THROTTLE.freeFailures + 1; ; failure++) {
      const penalty = 2 ** (failure - 1 - THROTTLE.freeFailures);
      const attemptStart = performance.now();
      const blocked = await login(email, randomPassword());
      const blockedAt = performance.now();
      if (blocked.statusCode === 401) {
        expect(
          (blockedAt - lastFailureStart) / 1000,
          `fallo ${String(failure)} durante la espera`,
        ).toBeGreaterThanOrEqual(penalty);
        expect(failure, 'la espera nunca se pudo observar').toBeLessThan(THROTTLE.softLockFailures);
        lastFailureStart = attemptStart;
        continue;
      }
      expect(blocked.statusCode).toBe(429);
      expect(retryAfter(blocked)).toBeLessThanOrEqual(penalty);
      expect(retryAfter(blocked)).toBeGreaterThanOrEqual(
        Math.max(1, Math.ceil(penalty - (blockedAt - lastFailureStart) / 1000)),
      );
      break;
    }
  });
});

describe('fuerza bruta por IP y credential stuffing', () => {
  it('una IP que falla contra muchas cuentas espera igual y dispara la señal IP_MANY_ACCOUNTS', async () => {
    const accounts: TestAccount[] = [];
    for (let i = 0; i < THROTTLE.distinctAccountsPerIp; i++)
      accounts.push(await createVerifiedUser(env.wallet, env.db));
    const attacker = '192.0.2.200';
    for (let i = 0; i < THROTTLE.freeFailures; i++) {
      expect((await login(accounts[i]?.email ?? '', randomPassword(), attacker)).statusCode).toBe(401);
    }
    // La IP espera aunque la próxima cuenta sea otra y la contraseña sea la correcta…
    const next = accounts[THROTTLE.freeFailures];
    const blocked = await login(next?.email ?? '', next?.password ?? '', attacker);
    expect(blocked.statusCode).toBe(429);
    expect(retryAfter(blocked)).toBe(1);
    // …mientras el dueño de esa cuenta, desde su IP, entra sin problema.
    expect((await login(next?.email ?? '', next?.password ?? '')).statusCode).toBe(200);

    let lastBlocked = blocked;
    for (let i: number = THROTTLE.freeFailures; i < THROTTLE.distinctAccountsPerIp; i++) {
      await waitPenalty(lastBlocked);
      expect((await login(accounts[i]?.email ?? '', randomPassword(), attacker)).statusCode).toBe(401);
      lastBlocked = await login(accounts[i]?.email ?? '', randomPassword(), attacker);
      if (i < THROTTLE.distinctAccountsPerIp - 1) expect(lastBlocked.statusCode).toBe(429);
    }

    const signals = await auditEvents('AUTH_RISK_SIGNAL');
    const manyAccounts = signals.filter((s) => (s.payload as { signal: string }).signal === 'IP_MANY_ACCOUNTS');
    expect(manyAccounts).toHaveLength(1);
    expect(manyAccounts[0]?.ip_prefix).toBe('192.0.2.0/24');
    expect(manyAccounts[0]?.payload).toMatchObject({ ipFailures: THROTTLE.distinctAccountsPerIp });
    const metric = await env.wallet.metrics.registry.getSingleMetricAsString('mtw_auth_risk_signals_total');
    expect(metric).toContain('signal="IP_MANY_ACCOUNTS"} 1');
  }, 120_000);

  it('un pico de fallos de la plataforma en un minuto dispara FAILURE_SPIKE una sola vez', async () => {
    // Listener con su propio Valkey y un umbral bajo: el contador de la plataforma no se mezcla con los demás tests.
    const redis = testRedis(REDIS_DBS.riskSignals);
    await redis.flushdb();
    const listener = await buildTestListener({
      db: env.db,
      redis,
      config: testConfig({ AUTH_FAILURE_SPIKE_PER_MINUTE: '8', RATE_LIMIT_GLOBAL_PER_MINUTE: '100000' }),
    });
    try {
      // Sin cruzar el borde de un minuto en medio de la ráfaga.
      const intoMinute = Date.now() % 60_000;
      if (intoMinute > 45_000) await sleep(60_000 - intoMinute + 200);
      for (let i = 0; i < 10; i++) {
        const response = await listener
          .newClient(freshIp())
          .post('/api/v1/auth/login', { email: randomEmail('stuffing'), password: randomPassword() });
        expect(response.statusCode).toBe(401);
      }
      const metric = await listener.metrics.registry.getSingleMetricAsString('mtw_auth_risk_signals_total');
      expect(metric).toContain('signal="FAILURE_SPIKE"} 1');
      const spikes = (await auditEvents('AUTH_RISK_SIGNAL')).filter(
        (s) => (s.payload as { signal: string }).signal === 'FAILURE_SPIKE',
      );
      expect(spikes).toHaveLength(1);
    } finally {
      await listener.close();
      await redis.quit();
    }
  }, 90_000);
});

describe('rate limits reales [B-RL]', () => {
  it('login: 5 por minuto por IP+email', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await login(account.email, randomPassword(), ip);
    const limited = await login(account.email, account.password, ip);
    expect(limited.statusCode).toBe(429);
    expect(retryAfter(limited)).toBeGreaterThan(30);
    expect(await env.wallet.metrics.registry.getSingleMetricAsString('mtw_rate_limit_hits_total')).toContain(
      'policy="login"',
    );
  });

  it('olvido: 3 por hora por email y 10 por hora por IP', async () => {
    const email = randomEmail('olvido');
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await env.wallet.newClient(freshIp()).post('/api/v1/auth/forgot-password', { email })).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);

    const ip = freshIp();
    const byIp: number[] = [];
    for (let i = 0; i < 11; i++)
      byIp.push(
        (await env.wallet.newClient(ip).post('/api/v1/auth/forgot-password', { email: randomEmail('ip') })).statusCode,
      );
    expect(byIp.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(byIp[10]).toBe(429);
    expect(await env.wallet.metrics.registry.getSingleMetricAsString('mtw_rate_limit_hits_total')).toContain(
      'policy="forgot-password"',
    );
  });
});

describe('TOTP', () => {
  async function enrolled() {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    const secret = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    const enabled = await browser.post('/api/v1/auth/totp/enable', { code: totpCode(secret) });
    return { account, secret, recoveryCodes: enabled.json<{ recoveryCodes: string[] }>().recoveryCodes };
  }

  it('replay: un código TOTP ya usado se rechaza', async () => {
    const { account, secret } = await enrolled();
    const code = totpCode(secret, Date.now() + 30_000);
    expect((await login(account.email, account.password, freshIp(), { totp: code })).statusCode).toBe(200);
    const replay = await login(account.email, account.password, freshIp(), { totp: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'INVALID_TOTP' });
  });

  it('los códigos de recuperación son de un solo uso', async () => {
    const { account, recoveryCodes } = await enrolled();
    const code = recoveryCodes[5] ?? '';
    expect((await login(account.email, account.password, freshIp(), { recoveryCode: code })).statusCode).toBe(200);
    expect((await login(account.email, account.password, freshIp(), { recoveryCode: code })).statusCode).toBe(401);
  });

  it('fuerza bruta del segundo factor: cada TOTP incorrecto cuenta y desde el 5.º hay espera', async () => {
    const { account, secret } = await enrolled();
    const valid = totpCode(secret, Date.now() + 30_000);
    for (let i = 0; i < THROTTLE.freeFailures; i++) {
      const guess = String((Number(valid) + 1 + i) % 1_000_000).padStart(6, '0');
      expect((await login(account.email, account.password, freshIp(), { totp: guess })).statusCode).toBe(401);
    }
    const blocked = await login(account.email, account.password, freshIp(), { totp: valid });
    expect(blocked.statusCode).toBe(429);
    const failures = await auditEvents('AUTH_LOGIN_FAILED', account.id);
    expect(failures.map((f) => (f.payload as { reason: string }).reason)).toEqual(
      Array<string>(THROTTLE.freeFailures).fill('invalid_totp'),
    );
  });
});
