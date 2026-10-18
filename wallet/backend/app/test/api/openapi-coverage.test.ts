// P08.T09 / P08.SEC: OpenAPI 3.1 generado desde Zod, una spec por listener con sólo sus rutas, ninguna ruta sin
// schema de request/response/errores, y Swagger UI con "Try it out" sólo fuera de producción.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../../src/api/errors.ts';
import { REQUIRED_ERROR_STATUSES } from '../../src/api/plugins/openapi.ts';
import type { RouteRegistrar } from '../../src/api/server.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { loadPolicySnapshot } from '../../src/policy/snapshot.ts';
import { SignerKeyService } from '../../src/signer-client/sharding.ts';
import { buildTestListener, unreachableRpc, type TestListener } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

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
      config: { auth: 'public' },
      schema: {
        operationId: 'testWalletOnly',
        tags: ['test'],
        summary: 'Ruta sólo del listener de Wallet',
        body: z.object({ value: z.string() }),
        response: { 201: z.object({ ok: z.boolean() }), ...errorResponses(403, 415, 422) },
      },
    },
    (_request, reply) => {
      reply.code(201);
      return { ok: true };
    },
  );
};

/** Rutas de ambos listeners hasta P10: health, auth, users, sessions y platform-sessions. */
const ACCOUNT_PATHS = [
  '/api/v1/health',
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/auth/csrf',
  '/api/v1/auth/register',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/verify-email/resend',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/unlock/request',
  '/api/v1/auth/unlock',
  '/api/v1/auth/totp/setup',
  '/api/v1/auth/totp/enable',
  '/api/v1/auth/totp/disable',
  '/api/v1/users/me',
  '/api/v1/sessions',
  '/api/v1/sessions/{id}',
  '/api/v1/platform-sessions/step-up/start',
  '/api/v1/platform-sessions/step-up/finish',
  '/api/v1/platform-sessions/check',
  '/api/v1/platform-sessions/{id}',
];
/**
 * El estado del enrollment de R lo consultan las dos apps (P12); el grupo `operations` (P13) existe en los dos
 * listeners: en Wallet firma U (OPERATIONS) y en Recovery firma R (RECOVERY).
 */
const SHARED_ONBOARDING_PATHS = [
  '/api/v1/recovery/enrollments/{id}',
  '/api/v1/wallets/{id}/operations',
  '/api/v1/operations/{id}',
  '/api/v1/operations/{id}/signatures',
  '/api/v1/operations/{id}/cancel',
];
/**
 * Sólo en el listener de Wallet ([B-API], [B-AUTHZ] 3): desbloqueo con U (OPAQUE), el grupo `wallet` y, del grupo
 * `recovery`, crear el enrollment e incorporar la autorización de U.
 */
const WALLET_ONLY_PATHS = [
  '/api/v1/platform-sessions/opaque/start',
  '/api/v1/platform-sessions/opaque/finish',
  '/api/v1/wallets',
  '/api/v1/wallets/me',
  '/api/v1/wallets/{id}/user-key/opaque-registration',
  '/api/v1/wallets/{id}/user-key',
  '/api/v1/wallets/{id}/user-key/restore',
  '/api/v1/wallets/{id}/executor',
  '/api/v1/wallets/{id}/deploy',
  '/api/v1/wallets/{id}/deployment',
  '/api/v1/wallets/{id}/recovery/enrollments',
  '/api/v1/recovery/enrollments/{id}/incorporate',
];
/** Sólo en el listener de Recovery: Enrollment Key y envío de R. */
const RECOVERY_ONLY_PATHS = [
  '/api/v1/recovery/enrollments/{id}/enrollment-key',
  '/api/v1/recovery/enrollments/{id}/submit',
];
/** Operaciones (método + ruta): GET y PATCH /users/me, GET y DELETE /sessions. */
const ACCOUNT_OPERATIONS = ACCOUNT_PATHS.length + 2;

let db: TestDatabase;
let snapshotDir: string;
const listeners: Record<'WALLET' | 'RECOVERY', TestListener | undefined> = { WALLET: undefined, RECOVERY: undefined };

beforeAll(async () => {
  db = await createTestDatabase();
  // Con los servicios de wallets (P12) se registran sus grupos; armar las rutas no consulta la cadena ni al signer.
  snapshotDir = mkdtempSync(join(tmpdir(), 'mtw-openapi-'));
  const key = edKey();
  const snapshot = loadPolicySnapshot(writePolicySnapshot(snapshotDir, key, vectorSystem()), key.publicKey, 'local');
  const rpc = unreachableRpc(
    createLogger({ level: 'silent', service: 'test' }),
    createMetrics({ defaultMetrics: false }),
  );
  const signerKeys = new SignerKeyService({
    db: db.app,
    shards: [{ id: 'dev-1', url: 'https://127.0.0.1:9', active: true }],
    clients: new Map(),
  });
  for (const client of ['WALLET', 'RECOVERY'] as const) {
    listeners[client] = await buildTestListener({
      db,
      client,
      extraRoutes: walletOnly,
      rpc,
      onchain: { rpc, snapshot: () => snapshot },
      signerKeys,
    });
  }
});
afterAll(async () => {
  rmSync(snapshotDir, { recursive: true, force: true });
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
    const shared = [...ACCOUNT_PATHS, ...SHARED_ONBOARDING_PATHS];
    expect(paths).toEqual(
      client === 'WALLET'
        ? [...shared, ...WALLET_ONLY_PATHS, '/api/v1/test/wallet-only'].sort()
        : [...shared, ...RECOVERY_ONLY_PATHS].sort(),
    );
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
          if (method === 'post' || method === 'patch') expect(operation.requestBody, where).toBeDefined();
        }
      }
    },
  );

  it.each(['WALLET', 'RECOVERY'] as const)('%s: ninguna ruta registrada queda fuera de la spec', async (client) => {
    const doc = await spec(client);
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)),
    );
    // Fastify registra `/sessions/:id`; OpenAPI lo publica como `/sessions/{id}`.
    const api = listeners[client]!.app.apiRoutes.map(
      (route) => `${route.method} ${route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`,
    );
    const shared = ACCOUNT_OPERATIONS + SHARED_ONBOARDING_PATHS.length;
    expect(api.length).toBe(
      client === 'WALLET' ? shared + WALLET_ONLY_PATHS.length + 1 : shared + RECOVERY_ONLY_PATHS.length,
    );
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
