// [B-AUTH-08] LoginRisk contra Valkey real: contadores por cuenta y por IP, esperas, señales una vez por ventana,
// limpieza sólo de la cuenta y claves sin datos personales en claro.
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LoginRisk, THROTTLE } from '../../src/auth/risk.ts';
import { testRedis } from '../helpers/api.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let redis: Redis;
const PLATFORM = 'mt-test';

beforeAll(() => {
  redis = testRedis(REDIS_DBS.riskUnit);
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe('LoginRisk', () => {
  it('sin IP (p. ej. un socket sin dirección) cuenta sólo la cuenta', async () => {
    const risk = new LoginRisk(redis, { failureSpikePerMinute: 1_000 });
    for (let i = 1; i <= THROTTLE.freeFailures; i++) {
      const outcome = await risk.recordFailure(PLATFORM, 'ana@test.invalid', null);
      expect(outcome).toMatchObject({ accountFailures: i, ipFailures: 0, signals: [] });
    }
    expect(await risk.retryAfter(PLATFORM, 'ana@test.invalid', null)).toBe(1);
    expect(await risk.retryAfter(PLATFORM, 'otra@test.invalid', null)).toBe(0);
  });

  it('la espera es la mayor entre cuenta e IP y crece exponencialmente hasta 15 min', async () => {
    const risk = new LoginRisk(redis, { failureSpikePerMinute: 1_000 });
    let last = { waitSeconds: 0 };
    for (let i = 0; i < 20; i++) last = await risk.recordFailure(PLATFORM, 'bea@test.invalid', '198.51.100.9');
    expect(last.waitSeconds).toBe(THROTTLE.maxWaitSeconds);
    const wait = await risk.retryAfter(PLATFORM, 'nadie@test.invalid', '198.51.100.9');
    expect(wait).toBeGreaterThan(THROTTLE.maxWaitSeconds - 5);
  });

  it('un login correcto limpia la cuenta pero no la IP', async () => {
    const risk = new LoginRisk(redis, { failureSpikePerMinute: 1_000 });
    const ip = '203.0.113.50';
    for (let i = 0; i < THROTTLE.freeFailures; i++)
      await risk.recordFailure(PLATFORM, `c${String(i)}@test.invalid`, ip);
    await risk.clearAccount(PLATFORM, 'c0@test.invalid');
    expect(await risk.retryAfter(PLATFORM, 'c0@test.invalid', ip)).toBeGreaterThan(0);
    expect(await risk.retryAfter(PLATFORM, 'c0@test.invalid', '203.0.113.51')).toBe(0);
  });

  it('cada señal se informa una sola vez por ventana', async () => {
    const risk = new LoginRisk(redis, { failureSpikePerMinute: 3 });
    const signals: string[] = [];
    for (let i = 0; i < 6; i++)
      signals.push(
        ...(await risk.recordFailure(PLATFORM, `d${String(i)}@test.invalid`, `192.0.2.${String(i + 1)}`)).signals,
      );
    expect(signals).toEqual(['FAILURE_SPIKE']);
  });

  it('las claves en Valkey son hashes: ni emails ni IPs en claro', async () => {
    const risk = new LoginRisk(redis, { failureSpikePerMinute: 1_000 });
    await risk.recordFailure(PLATFORM, 'privada@test.invalid', '198.51.100.77');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith('mtw:auth:')).toBe(true);
      expect(key).not.toContain('privada');
      expect(key).not.toContain('198.51.100');
    }
  });
});
