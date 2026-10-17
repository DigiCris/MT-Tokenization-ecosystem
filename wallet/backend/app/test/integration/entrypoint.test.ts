// Acceptance de P08 ("backend arranca contra compose + fork"): los entrypoints reales `api` y `worker` como procesos,
// contra PostgreSQL y Valkey reales y Anvil sobre el fork; readiness, docs, métricas, dispatcher del outbox y cierre
// ordenado con SIGTERM. La salida del proceso no contiene secretos.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { outboxJobId } from '../../src/queue/outbox-dispatcher.ts';
import { closeQueues, createQueues, QUEUES } from '../../src/queue/queues.ts';
import { createRedis } from '../../src/queue/redis.ts';
import { testRedisUrl } from '../helpers/api.ts';
import { localEnv } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { freePort, startAnvil, type AnvilInstance } from '../helpers/fork.ts';

const APP = resolve(import.meta.dirname, '../..');
const REDIS_DB = 7;

interface Running {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<number | null>;
}

function start(role: 'api' | 'worker', env: Record<string, string | undefined>): Running {
  const child = spawn(process.execPath, ['src/main.ts', role], {
    cwd: APP,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => {
      resolveExit(code);
    });
  });
  return {
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      return Promise.race([exited, sleep(15_000).then(() => -1)]);
    },
  };
}

async function waitFor(url: string, status = 200, timeoutMs = 60_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status === status) return response;
    } catch {
      // todavía no escucha
    }
    if (Date.now() > deadline) throw new Error(`timeout esperando ${String(status)} de ${url}`);
    await sleep(250);
  }
}

let anvil: AnvilInstance;
let db: TestDatabase;
let env: Record<string, string | undefined>;
let ports: { wallet: number; recovery: number; metrics: number; workerMetrics: number };

beforeAll(async () => {
  [anvil, db] = await Promise.all([startAnvil(), createTestDatabase()]);
  ports = {
    wallet: await freePort(),
    recovery: await freePort(),
    metrics: await freePort(),
    workerMetrics: await freePort(),
  };
  env = localEnv({
    LOG_LEVEL: 'info',
    MTW_ENV_FILE: '/dev/null',
    API_BIND_HOST: '127.0.0.1',
    API_WALLET_PORT: String(ports.wallet),
    API_RECOVERY_PORT: String(ports.recovery),
    METRICS_PORT: String(ports.metrics),
    WORKER_METRICS_PORT: String(ports.workerMetrics),
    API_PUBLIC_URL_WALLET: `http://127.0.0.1:${String(ports.wallet)}`,
    API_PUBLIC_URL_RECOVERY: `http://127.0.0.1:${String(ports.recovery)}`,
    DATABASE_URL: db.appUrl,
    REDIS_URL: testRedisUrl(REDIS_DB),
    RPC_PRIMARY_URL: anvil.url,
    RPC_SECONDARY_URL: anvil.url,
    OUTBOX_POLL_INTERVAL_MS: '100',
  });
}, 180_000);

afterAll(async () => {
  await Promise.all([anvil.stop(), db.close()]);
});

function expectNoSecrets(output: string): void {
  for (const name of [
    'AUDIT_CHAIN_KEY',
    'SESSION_SECRET',
    'CSRF_SECRET',
    'PASSWORD_PEPPER_V1',
    'SESSION_ISSUER_PRIVATE_KEY',
  ]) {
    expect(output).not.toContain(env[name]);
  }
  expect(output).not.toContain(new URL(db.appUrl).password);
  expect(output).not.toContain(new URL(testRedisUrl(REDIS_DB)).password);
}

describe('entrypoint api', () => {
  it('arranca los dos listeners, queda listo contra el fork, expone métricas y cierra con SIGTERM', async () => {
    const api = start('api', env);
    try {
      const ready = await waitFor(`http://127.0.0.1:${String(ports.wallet)}/api/v1/health/ready`);
      expect(await ready.json()).toMatchObject({ status: 'ready' });
      const recovery = await waitFor(`http://127.0.0.1:${String(ports.recovery)}/api/v1/health`);
      expect(await recovery.json()).toMatchObject({ listener: 'RECOVERY' });
      const spec = await waitFor(`http://127.0.0.1:${String(ports.recovery)}/docs/openapi.json`);
      expect(((await spec.json()) as { info: { title: string } }).info.title).toBe('MTW API — Recovery');
      const metrics = await (await waitFor(`http://127.0.0.1:${String(ports.metrics)}/metrics`)).text();
      expect(metrics).toContain('mtw_http_request_duration_seconds');
      expect(metrics).toContain('mtw_outbox_lag_seconds');
      expect(metrics).toContain('mtw_rpc_provider_healthy{provider="primary"} 1');
    } finally {
      expect(await api.stop()).toBe(0);
    }
    expect(api.output()).toContain('API escuchando');
    expectNoSecrets(api.output());
  });

  it('con configuración inválida sale con 1 y sin valores', async () => {
    const broken = start('api', {
      ...env,
      CSRF_SECRET: 'changeme',
      AUDIT_CHAIN_KEY: Buffer.alloc(32).toString('base64'),
    });
    const code = await new Promise<number | null>((resolveExit) => broken.child.once('exit', resolveExit));
    expect(code).toBe(1);
    expect(broken.output()).toContain('CSRF_SECRET: es un valor de ejemplo');
    expect(broken.output()).toContain('AUDIT_CHAIN_KEY: tiene baja entropía');
    expect(broken.output()).not.toContain('changeme');
  });
});

describe('entrypoint worker', () => {
  it('el dispatcher publica eventos del outbox en BullMQ y cierra con SIGTERM', async () => {
    const outbox = new OutboxRepository(db.app);
    const worker = start('worker', env);
    const producer = createRedis(testRedisUrl(REDIS_DB), 'producer', 'test-entrypoint', () => undefined);
    const queues = createQueues(producer, () => undefined);
    try {
      await waitFor(`http://127.0.0.1:${String(ports.workerMetrics)}/metrics`);
      const aggregateId = randomUUID();
      const id = await withTransaction(db.app, (trx) =>
        outbox.enqueue(trx, { aggregateType: 'wallet_operation', aggregateId, eventType: 'OPERATION_QUEUED' }),
      );
      const deadline = Date.now() + 20_000;
      for (;;) {
        const row = await db.app
          .selectFrom('outbox_events')
          .select('dispatched_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        if (row.dispatched_at) break;
        if (Date.now() > deadline) throw new Error('el worker no publicó el evento');
        await sleep(100);
      }
      const job = await queues[QUEUES.walletOperations].getJob(outboxJobId({ aggregate_id: aggregateId, id }));
      expect(job?.data.outboxEventId).toBe(id);
      const metrics = await (await fetch(`http://127.0.0.1:${String(ports.workerMetrics)}/metrics`)).text();
      expect(metrics).toContain('mtw_queue_jobs{queue="wallet-operations",state="waiting"}');
    } finally {
      await closeQueues(queues);
      await producer.quit();
      expect(await worker.stop()).toBe(0);
    }
    expect(worker.output()).toContain('worker iniciado');
    expectNoSecrets(worker.output());
  });
});
