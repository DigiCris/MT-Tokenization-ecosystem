// P08.T08 / P08.SEC: dos listeners con CORS estricto (sólo el origin de su frontend, con credenciales; otros origins
// rechazados en el servidor), helmet, límites de body, errores RFC 9457, requestId y client derivado del listener.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorResponses } from '../../src/api/errors.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const WALLET_ORIGIN = 'http://localhost:5173';
const RECOVERY_ORIGIN = 'http://localhost:5174';

const routes: RouteRegistrar = (app) => {
  app.post(
    '/test/echo',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'testEcho',
        tags: ['test'],
        summary: 'Eco validado',
        body: z.object({ amount: z.string().regex(/^\d+$/), note: z.string().max(10).optional() }),
        response: { 200: z.object({ amount: z.string() }), ...errorResponses(403, 409, 415) },
      },
    },
    (request) => ({ amount: request.body.amount }),
  );
  app.get(
    '/test/conflict',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'testConflict',
        tags: ['test'],
        summary: 'Error de dominio',
        response: { 200: z.object({ ok: z.boolean() }), ...errorResponses(409) },
      },
    },
    () => {
      throw new ApiError('CONFLICT', { detail: 'estado incompatible' });
    },
  );
};

let db: TestDatabase;
let wallet: TestListener;
let recovery: TestListener;

beforeAll(async () => {
  db = await createTestDatabase();
  wallet = await buildTestListener({ db, client: 'WALLET', extraRoutes: routes });
  recovery = await buildTestListener({ db, client: 'RECOVERY', extraRoutes: routes });
});
afterAll(async () => {
  await wallet.close();
  await recovery.close();
  await db.close();
});

describe('CORS por listener', () => {
  it.each([
    ['WALLET', WALLET_ORIGIN, RECOVERY_ORIGIN],
    ['RECOVERY', RECOVERY_ORIGIN, WALLET_ORIGIN],
  ] as const)('%s acepta sólo su frontend, con credenciales', async (client, own, other) => {
    const listener = client === 'WALLET' ? wallet : recovery;
    const ok = await listener.app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: own } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(own);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers.vary)).toContain('Origin');

    for (const origin of [other, 'https://evil.example', 'null', `${own}.evil.example`]) {
      const rejected = await listener.app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin } });
      expect(rejected.statusCode, origin).toBe(403);
      expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
      expect(rejected.headers['content-type']).toContain('application/problem+json');
      expect(rejected.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED', status: 403 });
    }
  });

  it('preflight: métodos, headers permitidos y caché; rechazado para otros origins', async () => {
    const preflight = await wallet.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/test/echo',
      headers: {
        origin: WALLET_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key,x-csrf-token',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(WALLET_ORIGIN);
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('Idempotency-Key');
    // Un request crítico firmado ([B-PSES-05]) desde el navegador manda los cuatro headers de la firma: todos tienen que
    // estar permitidos, si no el navegador no envía el request.
    const allowed = String(preflight.headers['access-control-allow-headers'])
      .toLowerCase()
      .split(/\s*,\s*/);
    for (const header of [
      'x-platform-session',
      'x-session-timestamp',
      'x-session-nonce',
      'x-session-signature',
      'x-csrf-token',
      'idempotency-key',
      'content-type',
    ]) {
      expect(allowed, header).toContain(header);
    }
    expect(preflight.headers['access-control-max-age']).toBe('600');

    const evil = await wallet.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/test/echo',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('sin Origin (no es CORS) el request sigue y no se agregan headers CORS', async () => {
    const response = await wallet.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('el origin del propio API se acepta sólo con "Try it out" habilitado (local/staging)', async () => {
    const local = await wallet.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://localhost:8080' },
    });
    expect(local.statusCode).toBe(200);
    const base = testConfig();
    const production = await buildTestListener({ db, config: { ...base, api: { ...base.api, docsTryItOut: false } } });
    try {
      const rejected = await production.app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { origin: 'http://localhost:8080' },
      });
      expect(rejected.statusCode).toBe(403);
    } finally {
      await production.close();
    }
  });
});

describe('headers de seguridad y contexto', () => {
  it('helmet, sin caché, sin x-powered-by y X-Request-Id generado por el servidor', async () => {
    const response = await wallet.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'forjado-por-el-cliente' },
    });
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('el client sale del listener, nunca de un header', async () => {
    const asWallet = await wallet.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-client': 'RECOVERY' },
    });
    expect(asWallet.json()).toMatchObject({ listener: 'WALLET' });
    const asRecovery = await recovery.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(asRecovery.json()).toMatchObject({ listener: 'RECOVERY' });
  });
});

describe('startApi', () => {
  it('levanta ambos listeners en sus puertos y cierra', async () => {
    const { startApi } = await import('../../src/api/server.ts');
    const { freePort } = await import('../helpers/fork.ts');
    const { IdempotencyRepository } = await import('../../src/db/repositories/idempotency-repository.ts');
    const { createLogger } = await import('../../src/observability/logger.ts');
    const base = testConfig();
    const config = { ...base, api: { ...base.api, walletPort: await freePort(), recoveryPort: await freePort() } };
    const running = await startApi({
      config,
      logger: createLogger({ level: 'silent', service: 'test' }),
      metrics: wallet.metrics,
      db: db.app,
      redis: wallet.redis,
      rpc: wallet.rpc,
      idempotency: new IdempotencyRepository(db.app),
      services: wallet.services,
      version: '0.0.0-test',
    });
    try {
      const walletHealth = await fetch(`http://127.0.0.1:${String(config.api.walletPort)}/api/v1/health`);
      const recoveryHealth = await fetch(`http://127.0.0.1:${String(config.api.recoveryPort)}/api/v1/health`);
      expect(await walletHealth.json()).toMatchObject({ listener: 'WALLET' });
      expect(await recoveryHealth.json()).toMatchObject({ listener: 'RECOVERY' });
    } finally {
      await running.close();
    }
  });
});

describe('errores RFC 9457', () => {
  it('ruta inexistente: 404 problem+json con el requestId del header', async () => {
    const response = await wallet.app.inject({ method: 'GET', url: '/api/v1/no-existe' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json<Record<string, unknown>>();
    expect(problem).toEqual({
      type: 'urn:mtw:problem:not-found',
      title: 'Recurso no encontrado',
      status: 404,
      code: 'NOT_FOUND',
      requestId: response.headers['x-request-id'],
    });
  });

  it('validación: 400 con los campos inválidos y sin repetir el valor recibido', async () => {
    const response = await wallet
      .newClient()
      .post('/api/v1/test/echo', { amount: 'uno-SECRETO', note: 'demasiado-largo-para-el-campo' });
    expect(response.statusCode).toBe(400);
    const problem = response.json<{ code: string; errors: { path: string; message: string }[] }>();
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors.map((e) => e.path).sort()).toEqual(['body.amount', 'body.note']);
    expect(response.body).not.toContain('uno-SECRETO');
  });

  it('errores de dominio con su status y detail', async () => {
    const response = await wallet.app.inject({ method: 'GET', url: '/api/v1/test/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'CONFLICT',
      detail: 'estado incompatible',
      type: 'urn:mtw:problem:conflict',
    });
  });

  it('body mayor al límite: 413; content-type no soportado: 415; JSON mal formado: 400', async () => {
    const big = await wallet.app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: '1', note: 'x'.repeat(70 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const text = await wallet.app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'amount=1',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });

    const malformed = await wallet.app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"amount":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
