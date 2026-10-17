// Pipeline de email real para los tests: dispatcher del outbox → BullMQ (Valkey) → worker de email → SMTP de Mailpit.
// Es el mismo código que corre el proceso `worker`; sólo el proveedor apunta al contenedor de Mailpit del test.
import type { Worker } from 'bullmq';
import type { Kysely } from 'kysely';
import { inject } from 'vitest';
import type { AppEnv } from '../../src/config/env.ts';
import type { Secret } from '../../src/config/secret.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import type { Database } from '../../src/db/schema.ts';
import { emailJobHandler } from '../../src/email/email-outbox.ts';
import type { EmailProvider } from '../../src/email/provider.ts';
import { SmtpProvider } from '../../src/email/smtp.ts';
import { createLogger, type Logger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { createOutboxWorker } from '../../src/queue/outbox-consumer.ts';
import { OUTBOX_EPOCH_KEY, OutboxDispatcher } from '../../src/queue/outbox-dispatcher.ts';
import { closeQueues, createQueues, QUEUES, type Queues } from '../../src/queue/queues.ts';
import { createRedis, type Redis } from '../../src/queue/redis.ts';
import { testRedisUrl } from './api.ts';

export interface EmailPipeline {
  provider: EmailProvider;
  metrics: Metrics;
  /** Colas del productor (para inspeccionar jobs fallidos o reintentos). */
  queues: Queues;
  stop: () => Promise<void>;
}

export async function startEmailPipeline(options: {
  db: Kysely<Database>;
  redisDb: number;
  fieldKey: Secret<Buffer>;
  appEnv?: AppEnv;
  provider?: EmailProvider;
  logger?: Logger;
}): Promise<EmailPipeline> {
  const logger = options.logger ?? createLogger({ level: 'silent', service: 'test-email' });
  const metrics = createMetrics({ defaultMetrics: false });
  const url = testRedisUrl(options.redisDb);
  const client: Redis = createRedis(url, 'client', 'test-email-client', () => undefined);
  const producer: Redis = createRedis(url, 'producer', 'test-email-producer', () => undefined);
  const workerConnection: Redis = createRedis(url, 'worker', 'test-email-worker', () => undefined);
  await client.set(OUTBOX_EPOCH_KEY, 'test');
  const queues = createQueues(producer, () => undefined);
  const outbox = new OutboxRepository(options.db);
  const mailpit = inject('mailpit');
  const provider =
    options.provider ??
    new SmtpProvider({ host: mailpit.smtpHost, port: mailpit.smtpPort, from: 'no-reply@wallet.localhost' });
  const dispatcher = new OutboxDispatcher({
    db: options.db,
    outbox,
    queues,
    redis: client,
    logger,
    metrics,
    options: { batchSize: 50, pollIntervalMs: 50 },
  });
  const worker: Worker = createOutboxWorker({
    queue: QUEUES.email,
    connection: workerConnection,
    outbox,
    logger,
    handler: emailJobHandler({
      provider,
      fieldKey: options.fieldKey,
      appEnv: options.appEnv ?? 'local',
      networkLabel: 'Base fork local — chainId 8453',
      logger,
      metrics,
    }),
  });
  dispatcher.start();
  return {
    provider,
    metrics,
    queues,
    stop: async () => {
      await dispatcher.stop();
      await worker.close();
      await closeQueues(queues);
      await provider.close();
      await Promise.all([client.quit(), producer.quit(), workerConnection.quit()]);
    },
  };
}
