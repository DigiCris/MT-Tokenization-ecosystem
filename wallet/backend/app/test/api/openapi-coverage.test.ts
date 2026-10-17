// P08.T09 / P08.SEC: OpenAPI 3.1 generado desde Zod, una spec por listener con sólo sus rutas, ninguna ruta sin
// schema de request/response/errores, y Swagger UI con "Try it out" sólo fuera de producción.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import { REQUIRED_ERROR_STATUSES } from '../../src/api/plugins/openapi.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

interface Spec {
  openapi: string;
  info: { title: string };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        summary?: string;
        tags?: string[];
        requestBody?: unknown;
        responses: Record<string, unknown>;
      }
    >
  >;
  components?: { schemas?: Record<string, unknown> };
}

/** Ruta de prueba sólo en el listener de Wallet: verifica que cada spec liste únicamente lo de su listener. */
const walletOnly: RouteRegistrar = (app, client) => {
  if (client !== 'WALLET') return;
  app.post(
    '/test/wallet-only',
    {
      schema: {
        operationId: 'testWalletOnly',
        tags: ['test'],
        summary: 'Ruta sólo del listener de Wallet',
        body: z.object({ value: z.string() }),
        response: { 201: z.object({ ok: z.boolean() }), ...errorResponses(422) },
      },
    },
    (_request, reply) => {
      reply.code(201);
      return { ok: true };
    },
  );
};

let db: TestDatabase;
const listeners: Record<'WALLET' | 'RECOVERY', TestListener | undefined> = { WALLET: undefined, RECOVERY: undefined };

beforeAll(async () => {
  db = await createTestDatabase();
  for (const client of ['WALLET', 'RECOVERY'] as const) {
    listeners[client] = await buildTestListener({ db, client, extraRoutes: walletOnly });
  }
});
afterAll(async () => {
  await Promise.all(
    Object.values(listeners)
      .filter((l): l is TestListener => l !== undefined)
      .map((l) => l.close()),
  );
  await db.close();
});

async function spec(client: 'WALLET' | 'RECOVERY'): Promise<Spec> {
  const response = await listeners[client]!.app.inject({ method: 'GET', url: '/docs/openapi.json' });
  expect(response.statusCode).toBe(200);
  return response.json<Spec>();
}

describe('spec OpenAPI por listener', () => {
  it.each(['WALLET', 'RECOVERY'] as const)('%s: OpenAPI 3.1 con su título y sólo sus rutas', async (client) => {
    const doc = await spec(client);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe(client === 'WALLET' ? 'MTW API — Wallet' : 'MTW API — Recovery');
    const paths = Object.keys(doc.paths).sort();
    const expected = ['/api/v1/health', '/api/v1/health/live', '/api/v1/health/ready'];
    expect(paths).toEqual(client === 'WALLET' ? [...expected, '/api/v1/test/wallet-only'].sort() : expected);
  });

  it.each(['WALLET', 'RECOVERY'] as const)(
    '%s: toda operación documenta request, 2xx y errores Problem',
    async (client) => {
      const doc = await spec(client);
      expect(doc.components?.schemas?.Problem).toBeDefined();
      for (const [path, operations] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          const where = `${method.toUpperCase()} ${path}`;
          expect(operation.operationId, where).toBeTypeOf('string');
          expect(operation.summary, where).toBeTypeOf('string');
          expect(operation.tags?.length, where).toBeGreaterThan(0);
          expect(
            Object.keys(operation.responses).some((s) => /^2\d\d$/.test(s)),
            where,
          ).toBe(true);
          for (const status of REQUIRED_ERROR_STATUSES) {
            const response = operation.responses[String(status)];
            expect(response, `${where} ${status}`).toBeDefined();
            expect(JSON.stringify(response), `${where} ${status}`).toContain('#/components/schemas/Problem');
          }
          if (method === 'post') expect(operation.requestBody, where).toBeDefined();
        }
      }
    },
  );

  it.each(['WALLET', 'RECOVERY'] as const)('%s: ninguna ruta registrada queda fuera de la spec', async (client) => {
    const doc = await spec(client);
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)),
    );
    const api = listeners[client]!.app.apiRoutes.map((route) => `${route.method} ${route.url}`);
    expect(api.length).toBe(client === 'WALLET' ? 4 : 3);
    for (const entry of api) expect(documented.has(entry), entry).toBe(true);
  });
});

describe('ninguna ruta sin schema', () => {
  const build = (routes: RouteRegistrar) => buildTestListener({ db, extraRoutes: routes });

  it('el servidor no arranca con una ruta sin schema', async () => {
    await expect(
      build((app) => {
        app.get('/test/undocumented', () => ({ ok: true }));
      }),
    ).rejects.toThrow(/ruta sin schema completo: GET \/api\/v1\/test\/undocumented: sin schema/);
  });

  it('ni con una ruta sin respuestas de error o sin schema de body', async () => {
    await expect(
      build((app) => {
        app.get(
          '/test/no-errors',
          {
            schema: {
              operationId: 'noErrors',
              tags: ['test'],
              summary: 'Sin errores',
              response: { 200: z.object({ ok: z.boolean() }) },
            },
          },
          () => ({ ok: true }),
        );
      }),
    ).rejects.toThrow(/falta la respuesta de error 400/);
    await expect(
      build((app) => {
        app.post(
          '/test/no-body',
          {
            schema: {
              operationId: 'noBody',
              tags: ['test'],
              summary: 'Sin body',
              response: { 200: z.object({ ok: z.boolean() }), ...errorResponses() },
            },
          },
          () => ({ ok: true }),
        );
      }),
    ).rejects.toThrow(/falta el schema del body/);
  });
});

describe('Swagger UI en /docs (§7.11)', () => {
  it('sirve la UI con su propia CSP y sin upgrade-insecure-requests en local', async () => {
    const page = await listeners.WALLET!.app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    const asset = await listeners.RECOVERY!.app.inject({ method: 'GET', url: '/docs/static/swagger-ui.css' });
    expect(asset.statusCode).toBe(200);
  });

  it('"Try it out" habilitado en local/staging y deshabilitado en producción', async () => {
    const local = await listeners.WALLET!.app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' });
    expect(local.body).toMatch(/"supportedSubmitMethods":\["get","post","patch","delete"\]/);
    // Sin barra "Explore": la UI no carga specs de otros orígenes.
    expect(local.body).toContain('"layout":"BaseLayout"');
    const base = testConfig();
    const production = await buildTestListener({
      db,
      config: { ...base, appEnv: 'production', api: { ...base.api, docsTryItOut: false } },
    });
    try {
      const initializer = await production.app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' });
      expect(initializer.body).toContain('"supportedSubmitMethods":[]');
      const page = await production.app.inject({ method: 'GET', url: '/docs' });
      expect(String(page.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
    } finally {
      await production.close();
    }
  });
});
