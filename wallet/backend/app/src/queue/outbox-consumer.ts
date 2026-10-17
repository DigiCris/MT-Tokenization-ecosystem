// Consumidor de una cola del outbox: ejecuta el handler y confirma el evento (processed_at) al terminar. Si el
// handler falla, BullMQ reintenta (DEFAULT_JOB_OPTIONS); un job que agota sus intentos queda fallido para inspección
// y su evento sigue sin procesar (lo muestran las métricas). Los handlers deben ser idempotentes: un evento puede
// entregarse más de una vez (re-encolado tras perder Valkey).
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Logger } from '../observability/logger.ts';
import { QUEUE_PREFIX, type OutboxJobData, type QueueName } from './queues.ts';

export type OutboxHandler = (data: OutboxJobData, job: Job<OutboxJobData>) => Promise<void>;

export function createOutboxWorker(options: {
  queue: QueueName;
  connection: Redis;
  outbox: OutboxRepository;
  handler: OutboxHandler;
  logger: Logger;
  concurrency?: number;
}): Worker<OutboxJobData> {
  const logger = options.logger.child({ component: 'outbox-consumer', queue: options.queue });
  const worker = new Worker<OutboxJobData>(
    options.queue,
    async (job) => {
      await options.handler(job.data, job);
      await options.outbox.markProcessed(job.data.outboxEventId);
    },
    { connection: options.connection, prefix: QUEUE_PREFIX, concurrency: options.concurrency ?? 8 },
  );
  worker.on('failed', (job, error) => {
    logger.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: error }, 'job del outbox falló');
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'error del worker de la cola');
  });
  return worker;
}
