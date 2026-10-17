// P08.T11 [B-RL]: rate limiting con store en Valkey real. Límite global por IP y listener, políticas con buckets por
// IP, email, usuario, sesión y Safe, contadores compartidos entre réplicas y entre listeners, buckets que no se
// comparten entre políticas, claves sin datos personales en claro y comportamiento fail-closed.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import {
  RATE_LIMIT_NAMESPACE,
  RATE_LIMIT_POLICIES,
  type RateLimitPolicyName,
} from '../../src/api/plugins/rate-limit.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { buildTestListener, testRedis, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const REDIS_DB = 5;

/** Ruta de prueba que aplica una política con las claves que llegan en el body. */
const routes: RouteRegistrar = (app) => {
  app.post(
    '/test/limited/:policy',
    {
      schema: {
        operationId: 'testLimited',
        tags: ['test'],
        summary: 'Aplica una política de rate limit',
        params: z.object({
          policy: z.enum(Object.keys(RATE_LIMIT_POLICIES) as [RateLimitPolicyName, ...RateLimitPolicyName[]]),
        }),
        body: z.object({
          email: z.string().optional(),
          user: z.string().optional(),
          session: z.string().optional(),
          safe: z.string().optional(),
          proposal: z.string().optional(),
          challengeType: z.string().optional(),
        }),
        response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
      },
    },
    async (request) => {
      const { email, user, session, safe, proposal, challengeType } = request.body;
      await app.enforceRateLimit(request, request.params.policy, {
        ...(email === undefined ? {} : { email }),
        ...(user === undefined ? {} : { user }),
        ...(session === undefined ? {} : { session }),
        ...(safe === undefined ? {} : { safe }),
        ...(proposal === undefined ? {} : { proposal }),
        ...(challengeType === undefined ? {} : { challengeType }),
      });
      return { ok: true };
    },
  );
};

let db: TestDatabase;
let redis: Redis;
const opened: TestListener[] = [];

async function listener(options: { client?: 'WALLET' | 'RECOVERY'; global?: number; redis?: Redis } = {}) {
  const built = await buildTestListener({
    db,
    client: options.client ?? 'WALLET',
    redis: options.redis ?? redis,
    metrics: createMetrics({ defaultMetrics: false }),
    configOverrides: { RATE_LIMIT_GLOBAL_PER_MINUTE: String(options.global ?? 10_000) },
    extraRoutes: routes,
  });
  opened.push(built);
  return built;
}

function hit(target: TestListener, policy: string, body: Record<string, string>, ip = '203.0.113.10') {
  return target.app.inject({ method: 'POST', url: `/api/v1/test/limited/${policy}`, remoteAddress: ip, payload: body });
}

async function statuses(n: number, fn: () => Promise<{ statusCode: number }>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fn()).statusCode);
  return out;
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = testRedis(REDIS_DB);
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await Promise.all(opened.map((l) => l.close()));
  await redis.quit();
  await db.close();
});

describe('límite global por IP (Swagger/API)', () => {
  it('rechaza con 429 RFC 9457, Retry-After y headers de rate limit; otra IP no se ve afectada', async () => {
    const api = await listener({ global: 5 });
    const codes = await statuses(6, () =>
      api.app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '198.51.100.7' }),
    );
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const limited = await api.app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '198.51.100.7' });
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-limit']).toBe('5');
    const other = await api.app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '198.51.100.8' });
    expect(other.statusCode).toBe(200);
    const hits = await api.metrics.registry.getSingleMetricAsString('mtw_rate_limit_hits_total');
    expect(hits).toContain('policy="global"');
  });

  it('el contador se comparte entre réplicas de la API (mismo Valkey) y es propio de cada listener', async () => {
    const [replicaA, replicaB] = [await listener({ global: 4 }), await listener({ global: 4 })];
    const recoveryApi = await listener({ global: 4, client: 'RECOVERY' });
    const get = (l: TestListener) =>
      l.app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '192.0.2.44' });
    expect(
      [await get(replicaA), await get(replicaB), await get(replicaA), await get(replicaB)].map((r) => r.statusCode),
    ).toEqual([200, 200, 200, 200]);
    expect((await get(replicaA)).statusCode).toBe(429);
    expect((await get(recoveryApi)).statusCode).toBe(200);
  });
});

describe('políticas [B-RL]', () => {
  it('login: 5/min por IP+email; otro email o la misma cuenta desde otra IP siguen', async () => {
    const api = await listener();
    const codes = await statuses(6, () => hit(api, 'login', { email: 'ana@dominio.com' }));
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await hit(api, 'login', { email: 'otro@dominio.com' })).statusCode).toBe(200);
    expect((await hit(api, 'login', { email: 'ana@dominio.com' }, '203.0.113.99')).statusCode).toBe(200);
    const hits = await api.metrics.registry.getSingleMetricAsString('mtw_rate_limit_hits_total');
    expect(hits).toContain('policy="login"');
  });

  it('send/swap prepare: 10/min por sesión; otra sesión del mismo usuario sigue', async () => {
    const api = await listener();
    const body = { session: 'sess-1', user: 'user-1', safe: '0xsafe1' };
    expect(await statuses(11, () => hit(api, 'send-swap-prepare', body))).toEqual([
      ...Array<number>(10).fill(200),
      429,
    ]);
    expect((await hit(api, 'send-swap-prepare', { ...body, session: 'sess-2' })).statusCode).toBe(200);
  });

  it('whitelist: 5/día por Safe y 10/día por usuario', async () => {
    const api = await listener();
    expect(await statuses(6, () => hit(api, 'whitelist-request', { safe: '0xsafeA', user: 'user-w' }))).toEqual([
      200, 200, 200, 200, 200, 429,
    ]);
    // El mismo usuario con otra Safe sigue hasta su propio límite diario (10).
    expect(await statuses(5, () => hit(api, 'whitelist-request', { safe: '0xsafeB', user: 'user-w' }))).toEqual([
      200, 200, 200, 200, 429,
    ]);
  });

  it('los buckets no se comparten entre políticas (el relay de cancelación tiene el suyo)', async () => {
    const api = await listener();
    expect(await statuses(11, () => hit(api, 'recovery-sensitive', { user: `u-${randomUUID()}` }))).toContain(429);
    expect((await hit(api, 'rotation-cancel-relay', { proposal: '0xprop' })).statusCode).toBe(200);
  });

  it('los contadores de una política se comparten entre los listeners de Wallet y Recovery', async () => {
    const [walletApi, recoveryApi] = [await listener(), await listener({ client: 'RECOVERY' })];
    const body = { email: 'compartida@dominio.com' };
    const codes = [];
    for (let i = 0; i < 6; i++)
      codes.push((await hit(i % 2 === 0 ? walletApi : recoveryApi, 'login', body)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('una política sin la clave que necesita es un error de configuración', async () => {
    const api = await listener();
    expect((await hit(api, 'send-swap-prepare', { user: 'u' })).statusCode).toBe(500);
  });

  it('Valkey guarda las claves hasheadas: sin emails ni IPs en claro', async () => {
    const api = await listener();
    await hit(api, 'login', { email: 'privada@dominio.com' }, '203.0.113.200');
    const keys = await redis.keys(`${RATE_LIMIT_NAMESPACE}*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain('@');
      expect(key).not.toContain('203.0.113');
    }
  });
});

describe('fail-closed', () => {
  it('si Valkey no responde, la API responde 503 en lugar de saltear el límite', async () => {
    const dead = new Redis('redis://127.0.0.1:9/0', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    dead.on('error', () => undefined);
    const api = await listener({ redis: dead });
    const response = await api.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    dead.disconnect();
  });
});
