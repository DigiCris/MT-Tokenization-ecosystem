// P08.T07: /health, /health/live y /health/ready contra dependencias reales (PostgreSQL, Valkey y Anvil sobre el
// fork), y 503 con el reporte cuando falta alguna: migraciones pendientes, Valkey caído o RPC inalcanzable.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReadiness } from '../../src/api/health.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { startAnvil, type AnvilInstance } from '../helpers/fork.ts';

const logger = createLogger({ level: 'silent', service: 'test' });

let anvil: AnvilInstance;
let db: TestDatabase;
let fresh: TestDatabase;
const opened: TestListener[] = [];

function forkRpc(url: string): RpcQuorumClient {
  return new RpcQuorumClient({
    primaryUrl: url,
    secondaryUrl: url,
    mode: 'local-single',
    chainId: 8453,
    timeoutMs: 10_000,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 1,
    backoffMs: 50,
    logger,
    metrics: createMetrics({ defaultMetrics: false }),
  });
}

async function api(options: { database?: TestDatabase; rpc?: RpcQuorumClient; redis?: Redis } = {}) {
  const built = await buildTestListener({
    db: options.database ?? db,
    rpc: options.rpc ?? forkRpc(anvil.url),
    ...(options.redis ? { redis: options.redis } : {}),
  });
  opened.push(built);
  return built;
}

beforeAll(async () => {
  [anvil, db, fresh] = await Promise.all([startAnvil(), createTestDatabase(), createTestDatabase({ migrated: false })]);
}, 180_000);
afterAll(async () => {
  await Promise.all(opened.map((l) => l.close()));
  await Promise.all([anvil.stop(), db.close(), fresh.close()]);
});

describe('health', () => {
  it('/health y /health/live responden sin depender de nada', async () => {
    const listener = await api();
    const health = await listener.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', service: 'mtw-backend', version: '0.0.0-test', listener: 'WALLET' });
    const live = await listener.app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.json()).toEqual({ status: 'ok' });
  });

  it('/health/ready: 200 con base migrada, Valkey y el fork de Base', async () => {
    const listener = await api();
    const ready = await listener.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    const body = ready.json<{
      status: string;
      checks: Record<string, { ok: boolean }> & { rpc: { providers: { head: string | null }[] } };
    }>();
    expect(body.status).toBe('ready');
    const checks: Record<string, unknown> = body.checks;
    expect(Object.values(checks).every((c) => (c as { ok: boolean }).ok)).toBe(true);
    expect(body.checks.rpc.providers[0]?.head).toMatch(/^\d+$/);
    expect(ready.body).not.toMatch(/postgres:\/\/|redis:\/\/|127\.0\.0\.1:\d+/);
  });

  it('/health/ready: 503 con migraciones pendientes', async () => {
    const listener = await api({ database: fresh });
    const ready = await listener.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        migrations: {
          ok: false,
          pending: [
            '0001_initial_schema',
            '0002_account_preferences',
            '0003_signer_key_attestation',
            '0004_wallet_onboarding',
            '0005_operation_pipeline',
            '0006_whitelist_send_swap',
            '0007_rotations_recovery_migration',
            '0008_executor_rotation_requests',
            '0009_recovery_enrollment_rejection',
            '0010_rotation_quarantine_rejection_email',
            '0011_u_replacement_rejection',
          ],
        },
      },
    });
  });

  it('/health/ready: 503 si Valkey no responde o el RPC es inalcanzable', async () => {
    const deadRedis = new Redis('redis://127.0.0.1:9/0', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    deadRedis.on('error', () => undefined);
    // El chequeo de readiness informa Valkey caído...
    const report = await checkReadiness({ db: db.app, redis: deadRedis, rpc: forkRpc(anvil.url), timeoutMs: 1_000 });
    expect(report.status).toBe('not_ready');
    expect(report.checks.valkey.ok).toBe(false);
    expect(report.checks.database.ok).toBe(true);
    // ...y por HTTP el rate limiter fail-closed ya responde 503 antes de llegar al handler.
    const valkeyDown = await api({ redis: deadRedis });
    const viaHttp = await valkeyDown.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(viaHttp.statusCode).toBe(503);
    expect(viaHttp.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    deadRedis.disconnect();

    const rpcDown = await api({ rpc: forkRpc('http://127.0.0.1:9') });
    const ready = await rpcDown.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      checks: { rpc: { ok: false, providers: [{ healthy: false, reason: 'UNREACHABLE' }] } },
    });
  });
});
