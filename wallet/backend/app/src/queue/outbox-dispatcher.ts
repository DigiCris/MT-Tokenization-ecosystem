// Dispatcher del outbox [B-Q-01]: publica en BullMQ los eventos que se escribieron en Postgres junto con su cambio de
// estado y los marca publicados. Postgres es la fuente de verdad (ADR-021):
//
// - jobId = `<aggregateId>-<outboxEventId>`: si el proceso cae entre publicar y marcar, la republicación del mismo
//   evento se deduplica; un evento nuevo del mismo agregado nunca se descarta aunque su job anterior siga activo.
// - Pérdida de Valkey (flush, volumen nuevo): un marcador de época en Valkey desaparece con el resto del estado; al
//   notarlo, el dispatcher vuelve a publicar todo lo publicado y no procesado y recién entonces recrea el marcador.
// - Barrido periódico: un evento publicado hace más de `staleAfterMs`, sin procesar y cuyo job ya no existe (pérdida
//   parcial) se vuelve a publicar. Los jobs fallidos no se reintentan solos: quedan para inspección y alerta.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Database, OutboxEventRow } from '../db/schema.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { scrubString } from '../observability/redaction.ts';
import { queueForEvent, QUEUE_PREFIX, type OutboxJobData, type Queues } from './queues.ts';

export const OUTBOX_EPOCH_KEY = `${QUEUE_PREFIX}:outbox:epoch`;

export interface OutboxDispatcherOptions {
  batchSize: number;
  pollIntervalMs: number;
  /** Antigüedad desde la publicación a partir de la cual un evento sin procesar y sin job se considera perdido. */
  staleAfterMs?: number;
  /** Cada cuántos ciclos se corre el barrido de eventos perdidos. */
  staleSweepEveryCycles?: number;
  /** Tiempo máximo para publicar un evento en la cola. */
  publishTimeoutMs?: number;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
}

export function outboxJobId(event: Pick<OutboxEventRow, 'aggregate_id' | 'id'>): string {
  return `${event.aggregate_id}-${event.id}`;
}

function jobData(event: OutboxEventRow): OutboxJobData {
  return {
    outboxEventId: event.id,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    eventType: event.event_type,
    payload: event.payload,
  };
}

export class OutboxDispatcher {
  readonly #db: Kysely<Database>;
  readonly #outbox: OutboxRepository;
  readonly #queues: Queues;
  readonly #redis: Redis;
  readonly #logger: Logger;
  readonly #metrics: Metrics;
  readonly #options: Required<OutboxDispatcherOptions>;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;
  #cycles = 0;

  constructor(deps: {
    db: Kysely<Database>;
    outbox: OutboxRepository;
    queues: Queues;
    redis: Redis;
    logger: Logger;
    metrics: Metrics;
    options: OutboxDispatcherOptions;
  }) {
    this.#db = deps.db;
    this.#outbox = deps.outbox;
    this.#queues = deps.queues;
    this.#redis = deps.redis;
    this.#logger = deps.logger.child({ component: 'outbox-dispatcher' });
    this.#metrics = deps.metrics;
    this.#options = { staleAfterMs: 5 * 60_000, staleSweepEveryCycles: 120, publishTimeoutMs: 5_000, ...deps.options };
  }

  async #publish(event: OutboxEventRow): Promise<void> {
    const queueName = queueForEvent(event.event_type);
    if (queueName === undefined) throw new Error(`evento sin cola asignada: ${event.event_type}`);
    // Con Valkey caído, BullMQ espera la reconexión sin límite: el timeout evita retener la transacción de Postgres.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#queues[queueName].add(event.event_type, jobData(event), { jobId: outboxJobId(event) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`timeout de ${this.#options.publishTimeoutMs} ms publicando en ${queueName}`));
          }, this.#options.publishTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.#metrics.outboxDispatched.inc({ queue: queueName });
  }

  /** Publica un lote de eventos pendientes. */
  async dispatchOnce(): Promise<DispatchResult> {
    return this.#db.transaction().execute(async (trx) => {
      const events = await this.#outbox.claimUndispatched(trx, this.#options.batchSize);
      const published: string[] = [];
      let failed = 0;
      for (const event of events) {
        try {
          await this.#publish(event);
          published.push(event.id);
        } catch (error) {
          failed++;
          this.#metrics.outboxDispatchErrors.inc();
          const message = scrubString(error instanceof Error ? error.message : String(error));
          await this.#outbox.recordDispatchError(trx, event.id, message);
          this.#logger.warn(
            { outboxEventId: event.id, eventType: event.event_type, err: error },
            'no se pudo publicar el evento',
          );
          // La cola no responde: el resto del lote queda pendiente para el próximo ciclo (sin acumular timeouts).
          break;
        }
      }
      await this.#outbox.markDispatched(trx, published);
      return { dispatched: published.length, failed };
    });
  }

  /** Detecta la pérdida del estado de Valkey y re-encola desde Postgres. Devuelve los eventos re-publicados. */
  async ensureEpoch(): Promise<number> {
    if ((await this.#redis.exists(OUTBOX_EPOCH_KEY)) === 1) return 0;
    let requeued = 0;
    let afterId: string | undefined;
    for (;;) {
      const events = await this.#outbox.dispatchedUnprocessed({
        limit: 500,
        ...(afterId === undefined ? {} : { afterId }),
      });
      for (const event of events) {
        await this.#publish(event);
        requeued++;
      }
      if (events.length < 500) break;
      afterId = events.at(-1)?.id;
    }
    // El marcador se recrea recién después de re-publicar: si el proceso cae a mitad, el próximo arranque repite.
    await this.#redis.set(OUTBOX_EPOCH_KEY, randomUUID(), 'NX');
    if (requeued > 0) {
      this.#metrics.outboxRequeued.inc(requeued);
      this.#logger.warn(
        { requeued },
        'Valkey perdió su estado: eventos publicados y no procesados re-encolados desde Postgres',
      );
    }
    return requeued;
  }

  /** Re-publica eventos publicados hace más de staleAfterMs, sin procesar y cuyo job ya no existe. */
  async requeueStale(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.#options.staleAfterMs);
    const after = new Date(now.getTime() - 24 * 3600_000);
    let requeued = 0;
    let afterId: string | undefined;
    for (;;) {
      const events = await this.#outbox.dispatchedUnprocessed({
        limit: 500,
        dispatchedBefore: before,
        dispatchedAfter: after,
        ...(afterId === undefined ? {} : { afterId }),
      });
      for (const event of events) {
        const queueName = queueForEvent(event.event_type);
        if (queueName === undefined) continue;
        const job = await this.#queues[queueName].getJob(outboxJobId(event));
        if (job) continue;
        await this.#publish(event);
        requeued++;
      }
      if (events.length < 500) break;
      afterId = events.at(-1)?.id;
    }
    if (requeued > 0) {
      this.#metrics.outboxRequeued.inc(requeued);
      this.#logger.warn({ requeued }, 'eventos publicados sin job (pérdida parcial de Valkey) re-encolados');
    }
    return requeued;
  }

  async runCycle(): Promise<DispatchResult> {
    await this.ensureEpoch();
    if (this.#cycles % this.#options.staleSweepEveryCycles === 0) await this.requeueStale();
    this.#cycles++;
    return this.dispatchOnce();
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = () => {
      this.#running = this.runCycle()
        .then((r) => (r.dispatched > 0 || r.failed > 0 ? 0 : this.#options.pollIntervalMs))
        .catch((error: unknown) => {
          this.#logger.error({ err: error }, 'ciclo del outbox falló');
          return this.#options.pollIntervalMs;
        })
        .then((delay) => {
          if (!this.#stopped) this.#timer = setTimeout(loop, delay);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}
