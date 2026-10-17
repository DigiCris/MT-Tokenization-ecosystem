// [B-Q-01] P08.T12: outbox transaccional → BullMQ sobre Valkey real. Publicación ordenada y deduplicada, consumidor
// que confirma, errores de publicación registrados y reintentados, dispatchers concurrentes sin duplicados y
// re-encolado desde Postgres cuando Valkey pierde su estado (FLUSHDB).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Worker } from 'bullmq';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { createOutboxWorker } from '../../src/queue/outbox-consumer.ts';
import { OUTBOX_EPOCH_KEY, OutboxDispatcher, outboxJobId } from '../../src/queue/outbox-dispatcher.ts';
import {
  closeQueues,
  createQueues,
  queueCounts,
  QUEUES,
  type OutboxJobData,
  type Queues,
} from '../../src/queue/queues.ts';
import { createRedis, type Redis } from '../../src/queue/redis.ts';
import { testRedisUrl } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const REDIS_DB = 3;
const logger = createLogger({ level: 'silent', service: 'test' });

let db: TestDatabase;
let outbox: OutboxRepository;
let client: Redis;
let producer: Redis;
let queues: Queues;
let metrics: Metrics;
const workers: Worker[] = [];

function dispatcher(
  options: Partial<ConstructorParameters<typeof OutboxDispatcher>[0]['options']> = {},
  override?: Partial<{ queues: Queues }>,
) {
  return new OutboxDispatcher({
    db: db.app,
    outbox,
    queues: override?.queues ?? queues,
    redis: client,
    logger,
    metrics,
    options: { batchSize: 100, pollIntervalMs: 50, ...options },
  });
}

async function enqueue(n: number, eventType = 'OPERATION_QUEUED'): Promise<string[]> {
  return withTransaction(db.app, async (trx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await outbox.enqueue(trx, {
          aggregateType: 'wallet_operation',
          aggregateId: randomUUID(),
          eventType,
          payload: { i },
        }),
      );
    }
    return ids;
  });
}

function startConsumer(processed: string[]): Worker {
  const worker = createOutboxWorker({
    queue: QUEUES.walletOperations,
    connection: createRedis(testRedisUrl(REDIS_DB), 'worker', 'test-worker', () => undefined),
    outbox,
    logger,
    handler: (data: OutboxJobData) => {
      processed.push(data.outboxEventId);
      return Promise.resolve();
    },
  });
  workers.push(worker);
  return worker;
}

async function until(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await sleep(50);
  }
}

const unprocessed = async (ids: string[]) =>
  (
    await db.app
      .selectFrom('outbox_events')
      .select('id')
      .where('id', 'in', ids)
      .where('processed_at', 'is', null)
      .execute()
  ).length;

beforeAll(async () => {
  db = await createTestDatabase();
  outbox = new OutboxRepository(db.app);
  client = createRedis(testRedisUrl(REDIS_DB), 'client', 'test-client');
  producer = createRedis(testRedisUrl(REDIS_DB), 'producer', 'test-producer');
  queues = createQueues(producer, () => undefined);
});

beforeEach(async () => {
  metrics = createMetrics({ defaultMetrics: false });
  await client.flushdb();
  await client.set(OUTBOX_EPOCH_KEY, 'test-epoch');
  await sql`UPDATE outbox_events SET dispatched_at = now(), processed_at = now() WHERE processed_at IS NULL`.execute(
    db.app,
  );
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});

afterAll(async () => {
  await closeQueues(queues);
  await Promise.all([client.quit(), producer.quit()]);
  await db.close();
});

describe('dispatcher del outbox', () => {
  it('publica en orden con jobId = <agregado>-<evento> y marca publicado', async () => {
    const ids = await enqueue(3);
    expect(await dispatcher().dispatchOnce()).toEqual({ dispatched: 3, failed: 0 });
    const rows = await db.app.selectFrom('outbox_events').selectAll().where('id', 'in', ids).orderBy('id').execute();
    for (const row of rows) {
      expect(row.dispatched_at).toBeInstanceOf(Date);
      expect(row.attempts).toBe(1);
      const job = await queues[QUEUES.walletOperations].getJob(outboxJobId(row));
      expect(job?.data).toEqual({
        outboxEventId: row.id,
        aggregateType: 'wallet_operation',
        aggregateId: row.aggregate_id,
        eventType: 'OPERATION_QUEUED',
        payload: row.payload,
      });
    }
    expect(await metrics.registry.getSingleMetricAsString('mtw_outbox_dispatched_total')).toContain(
      'queue="wallet-operations"} 3',
    );
  });

  it('republicar el mismo evento (caída entre publicar y marcar) no duplica el job', async () => {
    const [id] = await enqueue(1);
    await dispatcher().dispatchOnce();
    await sql`UPDATE outbox_events SET dispatched_at = NULL WHERE id = ${id}`.execute(db.app);
    await dispatcher().dispatchOnce();
    expect((await queueCounts(queues))[QUEUES.walletOperations]?.waiting).toBe(1);
  });

  it('el consumidor procesa y confirma (processed_at)', async () => {
    const ids = await enqueue(4);
    const processed: string[] = [];
    startConsumer(processed);
    await dispatcher().dispatchOnce();
    await until(async () => (await unprocessed(ids)) === 0);
    expect(processed.sort()).toEqual([...ids].sort());
  });

  it('un handler que falla deja el job fallido y el evento sin procesar (visible en métricas)', async () => {
    const [id] = await enqueue(1);
    const row = await db.app
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id ?? '')
      .executeTakeFirstOrThrow();
    const worker = createOutboxWorker({
      queue: QUEUES.walletOperations,
      connection: createRedis(testRedisUrl(REDIS_DB), 'worker', 'test-failing-worker', () => undefined),
      outbox,
      logger,
      handler: () => Promise.reject(new Error('handler roto')),
    });
    workers.push(worker);
    // Un solo intento para no esperar el backoff de DEFAULT_JOB_OPTIONS.
    await queues[QUEUES.walletOperations].add(
      row.event_type,
      {
        outboxEventId: row.id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
      },
      { jobId: outboxJobId(row), attempts: 1 },
    );
    await until(async () => (await queueCounts(queues))[QUEUES.walletOperations]?.failed === 1);
    expect(await unprocessed([row.id])).toBe(1);
  });

  it('un error de publicación queda registrado y el evento se publica cuando la cola vuelve', async () => {
    const [id] = await enqueue(1);
    const [other] = await enqueue(1);
    const dead = createRedis('redis://:x@127.0.0.1:9/0', 'producer', 'test-dead', () => undefined);
    const deadQueues = createQueues(dead, () => undefined);
    // El primer evento agota el timeout de publicación y el resto del lote queda para el próximo ciclo.
    expect(await dispatcher({ publishTimeoutMs: 300 }, { queues: deadQueues }).dispatchOnce()).toEqual({
      dispatched: 0,
      failed: 1,
    });
    const untouched = await db.app
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', other ?? '')
      .executeTakeFirstOrThrow();
    expect(untouched.attempts).toBe(0);
    const failed = await db.app
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id ?? '')
      .executeTakeFirstOrThrow();
    expect(failed.dispatched_at).toBeNull();
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).not.toBeNull();
    expect(failed.last_error).not.toContain(':x@');
    await closeQueues(deadQueues).catch(() => undefined);
    dead.disconnect();
    expect(await dispatcher().dispatchOnce()).toEqual({ dispatched: 2, failed: 0 });
  });

  it('dos dispatchers concurrentes publican cada evento una sola vez', async () => {
    const ids = await enqueue(40);
    const [a, b] = await Promise.all(
      [dispatcher({ batchSize: 7 }), dispatcher({ batchSize: 7 })].map(async (d) => {
        let total = 0;
        for (;;) {
          const r = await d.dispatchOnce();
          total += r.dispatched;
          if (r.dispatched === 0) return total;
        }
      }),
    );
    expect((a ?? 0) + (b ?? 0)).toBe(40);
    expect((await queueCounts(queues))[QUEUES.walletOperations]?.waiting).toBe(40);
    const rows = await db.app.selectFrom('outbox_events').select('attempts').where('id', 'in', ids).execute();
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });
});

describe('resiliencia a la pérdida de Valkey', () => {
  it('tras un FLUSHDB re-encola desde Postgres todo lo publicado y no procesado', async () => {
    const ids = await enqueue(5);
    const d = dispatcher();
    await d.runCycle();
    expect((await queueCounts(queues))[QUEUES.walletOperations]?.waiting).toBe(5);

    await client.flushdb();
    expect((await queueCounts(queues))[QUEUES.walletOperations]?.waiting).toBe(0);
    expect(await d.ensureEpoch()).toBe(5);
    expect(await client.exists(OUTBOX_EPOCH_KEY)).toBe(1);
    expect(await d.ensureEpoch()).toBe(0);
    expect(await metrics.registry.getSingleMetricAsString('mtw_outbox_requeued_total')).toContain(' 5');

    const processed: string[] = [];
    startConsumer(processed);
    await until(async () => (await unprocessed(ids)) === 0);
    expect(new Set(processed)).toEqual(new Set(ids));
  });

  it('el barrido re-publica eventos viejos sin job y deja los que todavía tienen job', async () => {
    const [lost, alive] = await enqueue(2);
    await dispatcher().dispatchOnce();
    await sql`UPDATE outbox_events SET dispatched_at = now() - interval '10 minutes' WHERE id IN (${lost}, ${alive})`.execute(
      db.app,
    );
    const lostRow = await db.app
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', lost ?? '')
      .executeTakeFirstOrThrow();
    await (await queues[QUEUES.walletOperations].getJob(outboxJobId(lostRow)))?.remove();
    expect(await dispatcher({ staleAfterMs: 60_000 }).requeueStale()).toBe(1);
    expect(await queues[QUEUES.walletOperations].getJob(outboxJobId(lostRow))).toBeDefined();
  });

  it('el loop del dispatcher publica eventos nuevos y se detiene limpio', async () => {
    const processed: string[] = [];
    startConsumer(processed);
    const d = dispatcher({ pollIntervalMs: 50 });
    d.start();
    const ids = await enqueue(3);
    await until(async () => (await unprocessed(ids)) === 0);
    await d.stop();
    expect(processed).toEqual(expect.arrayContaining(ids));
  });
});
