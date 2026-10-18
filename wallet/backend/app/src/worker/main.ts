// Worker S (P13): consumidor de la cola `wallet-operations` (evento OPERATION_QUEUED del outbox) y lazos periódicos:
//
// - scheduler: FAILED_RETRYABLE vencidas → QUEUED [B-Q-03]; Safes con operaciones en curso (VALIDATING/READY/
//   SUBMITTED) cuyo lease venció → se retoman [B-Q-04]; QUEUED sin procesar (job perdido) y bloqueadas por nonce menor
//   → se vuelven a mirar;
// - barrido: CREATED vencidas → EXPIRED y firmas de más de 24 h → SIGNATURE_STALE;
// - watcher de finalidad y reorgs [B-FIN-02], indexer [B-FIN-03] y reconciliación (cada 60 s las wallets con
//   operaciones no finales; una vez por día todas);
// - efectos (P14): whitelist desde los eventos on-chain, grupos de swap y avisos de alto valor.
//
// Paralelo ENTRE Safes (concurrencia configurable, default 8) y secuencial DENTRO de cada Safe (lease) [B-Q-05].
import { Worker } from 'bullmq';
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { ChainIndexer } from '../chain/indexer.ts';
import type { Reconciler } from '../chain/reconciler.ts';
import type { FinalityWatcher } from '../chain/watcher.ts';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Database } from '../db/schema.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OperationService } from '../operations/service.ts';
import { TransitionConflictError, type OperationStateMachine } from '../operations/state-machine.ts';
import { QUEUE_PREFIX, QUEUES, type OutboxJobData } from '../queue/queues.ts';
import type { OperationPipeline } from './pipeline.ts';

export interface OperationsWorkerDeps {
  db: Kysely<Database>;
  connection: Redis;
  outbox: OutboxRepository;
  machine: OperationStateMachine;
  pipeline: OperationPipeline;
  operations: OperationService;
  watcher: FinalityWatcher;
  indexer: ChainIndexer;
  reconciler: Reconciler;
  /** P14: whitelist, grupos de swap y avisos de alto valor (worker/effects.ts). */
  effects?: { runOnce: () => Promise<unknown> };
  logger: Logger;
  metrics: Metrics;
  options: {
    concurrency: number;
    schedulerIntervalMs?: number;
    sweepIntervalMs?: number;
    watcherIntervalMs: number;
    indexerIntervalMs: number;
    reconcilerIntervalMs: number;
    /** Período de la reconciliación completa (default 24 h). */
    fullReconcileIntervalMs?: number;
    /** Período de los efectos (default 5 s). */
    effectsIntervalMs?: number;
    /** Desactiva los lazos periódicos (tests que los manejan a mano). */
    loops?: boolean;
  };
}

export interface OperationsWorker {
  worker: Worker<OutboxJobData>;
  /** Procesa una Safe ya (sin esperar al scheduler). */
  kick: (walletId: string) => Promise<void>;
  /** Una pasada del scheduler (tests). */
  schedule: () => Promise<void>;
  close: () => Promise<void>;
}

/** Lazo periódico sin solapamiento: la próxima pasada empieza cuando terminó la anterior. */
function loop(name: string, intervalMs: number, fn: () => Promise<unknown>, logger: Logger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    running = fn()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ err: error, loop: name }, 'falló una pasada del lazo periódico');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, intervalMs);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}

export function startOperationsWorker(deps: OperationsWorkerDeps): OperationsWorker {
  const logger = deps.logger.child({ component: 'operations-worker' });
  const inFlight = new Map<string, Promise<void>>();

  /** processWallet sin duplicar dentro del proceso (entre procesos lo evita el lease). */
  const kick = (walletId: string): Promise<void> => {
    const running = inFlight.get(walletId);
    if (running) return running;
    const run = deps.pipeline
      .processWallet(walletId)
      .catch((error: unknown) => {
        logger.error({ err: error, walletId }, 'falló el procesamiento de la Safe');
        throw error;
      })
      .finally(() => inFlight.delete(walletId));
    inFlight.set(walletId, run);
    return run;
  };

  const worker = new Worker<OutboxJobData>(
    QUEUES.walletOperations,
    async (job) => {
      const op = await deps.db
        .selectFrom('wallet_operations')
        .select('wallet_id')
        .where('id', '=', job.data.aggregateId)
        .executeTakeFirst();
      if (op) await kick(op.wallet_id);
      await deps.outbox.markProcessed(job.data.outboxEventId);
    },
    { connection: deps.connection, prefix: QUEUE_PREFIX, concurrency: deps.options.concurrency },
  );
  worker.on('failed', (job, error) => {
    logger.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: error }, 'job de operación falló');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'error del worker de la cola wallet-operations');
  });

  const schedule = async (): Promise<void> => {
    // [B-Q-03] Reintentos vencidos: FAILED_RETRYABLE → QUEUED con su evento de outbox.
    const due = await deps.db
      .selectFrom('wallet_operations')
      .select(['id', 'wallet_id'])
      .where('status', '=', 'FAILED_RETRYABLE')
      .where('next_attempt_at', '<=', sql<Date>`now()`)
      .orderBy('next_attempt_at')
      .limit(200)
      .execute();
    for (const op of due) {
      try {
        await deps.machine.transition({
          operationId: op.id,
          from: ['FAILED_RETRYABLE'],
          to: 'QUEUED',
          actor: { type: 'WORKER', id: 'retry-scheduler' },
          patch: { blocked_reason: null },
          outbox: { eventType: 'OPERATION_QUEUED', payload: { operationId: op.id, walletId: op.wallet_id } },
        });
        deps.metrics.operationTransitions.inc({ to: 'QUEUED' });
      } catch (error) {
        if (!(error instanceof TransitionConflictError)) throw error;
      }
    }
    // [B-Q-04] Operaciones en curso sin dueño (lease vencido o liberado), QUEUED que nadie tomó (job perdido o lease
    // ocupado al llegar el evento) y bloqueadas por un nonce menor que quizá ya se ejecutó por fuera.
    const orphans = await sql<{ wallet_id: string }>`
      SELECT DISTINCT o.wallet_id FROM wallet_operations o JOIN wallets w ON w.id = o.wallet_id
      WHERE (w.exec_lease_expires_at IS NULL OR w.exec_lease_expires_at < now())
        AND (o.status IN ('VALIDATING', 'READY', 'SUBMITTED')
             OR (o.status = 'QUEUED' AND o.updated_at < now() - interval '15 seconds'))
      LIMIT 100`.execute(deps.db);
    await Promise.allSettled(orphans.rows.map((r) => kick(r.wallet_id)));
  };

  const closers: (() => Promise<void>)[] = [];
  if (deps.options.loops ?? true) {
    closers.push(loop('scheduler', deps.options.schedulerIntervalMs ?? 2_000, schedule, logger));
    closers.push(loop('sweep', deps.options.sweepIntervalMs ?? 30_000, () => deps.operations.sweep(), logger));
    closers.push(loop('watcher', deps.options.watcherIntervalMs, () => deps.watcher.runOnce(), logger));
    closers.push(loop('indexer', deps.options.indexerIntervalMs, () => deps.indexer.runOnce(), logger));
    closers.push(
      loop('reconciler', deps.options.reconcilerIntervalMs, () => deps.reconciler.runOnce('active'), logger),
    );
    closers.push(
      loop(
        'reconciler-full',
        deps.options.fullReconcileIntervalMs ?? 24 * 3600_000,
        () => deps.reconciler.runOnce('full'),
        logger,
      ),
    );
    const effects = deps.effects;
    if (effects)
      closers.push(loop('effects', deps.options.effectsIntervalMs ?? 5_000, () => effects.runOnce(), logger));
    // Al arrancar: retomar lo que dejó un worker caído sin esperar al primer tick.
    void schedule().catch((error: unknown) => {
      logger.error({ err: error }, 'falló la recuperación inicial de operaciones');
    });
  }

  return {
    worker,
    kick,
    schedule,
    close: async () => {
      await worker.close();
      for (const close of closers) await close();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
