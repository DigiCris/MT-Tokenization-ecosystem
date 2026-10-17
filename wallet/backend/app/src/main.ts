// Entrypoint del backend: `node main api` (listeners Wallet y Recovery), `node main worker` (dispatcher del outbox
// y mantenimiento; el worker S de P13 se suma a este proceso) o `node main gas-tank` (recargas de las S por el shard
// `platform` del signer, [B-SIG-05]). Cierre ordenado con SIGTERM/SIGINT.
import type { Server } from 'node:http';
import { sql, type Kysely } from 'kysely';
import { startApi } from './api/server.ts';
import { RpcQuorumClient } from './chain/rpc-quorum.ts';
import { loadConfig, loadSignerClientConfig, type AppConfig } from './config/env.ts';
import { createDatabase } from './db/kysely.ts';
import { IdempotencyRepository } from './db/repositories/idempotency-repository.ts';
import { OutboxRepository } from './db/repositories/outbox-repository.ts';
import type { Database } from './db/schema.ts';
import { emailJobHandler } from './email/email-outbox.ts';
import { createEmailProvider } from './email/provider.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import { createMetrics, registerScrapeGauges, startMetricsServer, type Metrics } from './observability/metrics.ts';
import { scrubString } from './observability/redaction.ts';
import { createOutboxWorker } from './queue/outbox-consumer.ts';
import { OutboxDispatcher } from './queue/outbox-dispatcher.ts';
import { closeQueues, createQueues, queueCounts, QUEUES } from './queue/queues.ts';
import { createRedis } from './queue/redis.ts';
import { GasTankService } from './gas/gas-tank.ts';
import { loadPolicySnapshot } from './policy/snapshot.ts';
import { createAccountServices } from './services.ts';
import { readSignerTls, SignerClient } from './signer-client/client.ts';
import { serviceVersion } from './version.ts';

type Role = 'api' | 'worker' | 'gas-tank';
type Closer = () => Promise<unknown>;

/** Errores de conexión repetidos (Valkey caído reintenta cada segundo): uno por cada 30 s en los logs. */
function throttledWarn(logger: Logger, message: string): (error: Error) => void {
  let last = 0;
  return (error) => {
    const now = Date.now();
    if (now - last < 30_000) return;
    last = now;
    logger.warn({ err: error }, message);
  };
}

async function operationsByStatus(db: Kysely<Database>): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }>`
    SELECT status, count(*)::int AS n FROM wallet_operations GROUP BY status`.execute(db);
  return Object.fromEntries(rows.rows.map((r) => [r.status, r.n]));
}

async function startRole(role: Role, config: AppConfig, logger: Logger, metrics: Metrics): Promise<Closer[]> {
  const closers: Closer[] = [];
  const db = createDatabase({
    connectionString: config.database.url.reveal(),
    poolMax: config.database.poolMax,
    applicationName: `mtw-${role}`,
    onPoolError: (error) => {
      logger.error({ err: error }, 'error en una conexión inactiva del pool de PostgreSQL');
    },
  });
  closers.push(() => db.destroy());
  const redis = createRedis(
    config.redis.url.reveal(),
    'client',
    `mtw-${role}`,
    throttledWarn(logger, 'error de conexión con Valkey'),
  );
  closers.push(() => redis.quit());
  const outbox = new OutboxRepository(db);
  const idempotency = new IdempotencyRepository(db);
  let metricsServer: Server;

  if (role === 'api') {
    const rpc = new RpcQuorumClient({
      primaryUrl: config.rpc.primaryUrl.reveal(),
      secondaryUrl: config.rpc.secondaryUrl.reveal(),
      mode: config.rpc.quorumMode,
      chainId: config.chainId,
      timeoutMs: config.rpc.timeoutMs,
      healthIntervalMs: config.rpc.healthIntervalMs,
      maxHeadLagBlocks: config.rpc.maxHeadLagBlocks,
      retries: config.rpc.quorumRetries,
      backoffMs: config.rpc.quorumBackoffMs,
      logger,
      metrics,
    });
    rpc.start();
    closers.unshift(() => rpc.stop());
    registerScrapeGauges(metrics, {
      outboxLagSeconds: () => outbox.oldestUndispatchedAgeSeconds(),
      operationsByStatus: () => operationsByStatus(db),
    });
    const services = await createAccountServices({ config, db, redis, outbox, metrics, logger });
    const api = await startApi({
      config,
      logger,
      metrics,
      db,
      redis,
      rpc,
      idempotency,
      services,
      version: serviceVersion(),
    });
    closers.unshift(() => api.close());
    metricsServer = await startMetricsServer(metrics.registry, config.metrics.bindHost, config.metrics.port);
    logger.info(
      { walletPort: config.api.walletPort, recoveryPort: config.api.recoveryPort, metricsPort: config.metrics.port },
      'API escuchando',
    );
  } else if (role === 'gas-tank') {
    const signer = loadSignerClientConfig();
    if (signer.platformUrl === undefined) throw new Error('SIGNER_PLATFORM_URL: requerida para el gas tank');
    const rpc = new RpcQuorumClient({
      primaryUrl: config.rpc.primaryUrl.reveal(),
      secondaryUrl: config.rpc.secondaryUrl.reveal(),
      mode: config.rpc.quorumMode,
      chainId: config.chainId,
      timeoutMs: config.rpc.timeoutMs,
      healthIntervalMs: config.rpc.healthIntervalMs,
      maxHeadLagBlocks: config.rpc.maxHeadLagBlocks,
      retries: config.rpc.quorumRetries,
      backoffMs: config.rpc.quorumBackoffMs,
      logger,
      metrics,
    });
    rpc.start();
    closers.unshift(() => rpc.stop());
    const snapshot = loadPolicySnapshot(signer.policy.snapshotPath, signer.policy.publicKey, config.appEnv);
    const platform = new SignerClient({
      shardId: 'platform',
      url: signer.platformUrl,
      tls: readSignerTls(signer.mtls),
      timeoutMs: signer.timeoutMs,
    });
    closers.push(() => {
      platform.close();
      return Promise.resolve();
    });
    const gasTank = new GasTankService({
      db,
      rpc,
      platform,
      policy: () => snapshot,
      config: signer.gasTank,
      logger,
      metrics,
    });
    gasTank.start(signer.gasTank.intervalMs);
    closers.unshift(() => gasTank.stop());
    metricsServer = await startMetricsServer(metrics.registry, config.metrics.bindHost, config.metrics.gasTankPort);
    logger.info({ metricsPort: config.metrics.gasTankPort, policyVersion: snapshot.version }, 'gas tank iniciado');
  } else {
    const producer = createRedis(
      config.redis.url.reveal(),
      'producer',
      'mtw-worker-producer',
      throttledWarn(logger, 'error de conexión con Valkey (productor)'),
    );
    closers.push(() => producer.quit());
    const queues = createQueues(producer, throttledWarn(logger, 'error de una cola BullMQ'));
    closers.unshift(() => closeQueues(queues));
    const dispatcher = new OutboxDispatcher({
      db,
      outbox,
      queues,
      redis,
      logger,
      metrics,
      options: { batchSize: config.outbox.batchSize, pollIntervalMs: config.outbox.pollIntervalMs },
    });
    dispatcher.start();
    closers.unshift(() => dispatcher.stop());
    // Consumidor de la cola de email [B-MAIL-01] (Mailgun en staging/producción, SMTP/Mailpit en local).
    const provider = createEmailProvider(config.email);
    closers.push(() => provider.close());
    const emailConnection = createRedis(
      config.redis.url.reveal(),
      'worker',
      'mtw-worker-email',
      throttledWarn(logger, 'error de conexión con Valkey (cola de email)'),
    );
    closers.push(() => emailConnection.quit());
    const emailWorker = createOutboxWorker({
      queue: QUEUES.email,
      connection: emailConnection,
      outbox,
      logger,
      concurrency: 4,
      handler: emailJobHandler({
        provider,
        fieldKey: config.secrets.fieldEncryptionKey,
        appEnv: config.appEnv,
        networkLabel: config.email.networkLabel,
        logger,
        metrics,
      }),
    });
    closers.unshift(() => emailWorker.close());
    const maintenance = setInterval(() => {
      idempotency.deleteExpired().catch((error: unknown) => {
        logger.warn({ err: error }, 'limpieza de claves de idempotencia falló');
      });
    }, 3600_000);
    maintenance.unref();
    closers.unshift(() => {
      clearInterval(maintenance);
      return Promise.resolve();
    });
    registerScrapeGauges(metrics, {
      queueCounts: () => queueCounts(queues),
      outboxLagSeconds: () => outbox.oldestUndispatchedAgeSeconds(),
    });
    metricsServer = await startMetricsServer(metrics.registry, config.metrics.bindHost, config.metrics.workerPort);
    logger.info(
      { metricsPort: config.metrics.workerPort, emailProvider: provider.name },
      'worker iniciado (outbox y email)',
    );
  }
  closers.unshift(
    () =>
      new Promise<void>((resolveClose) => {
        metricsServer.close(() => {
          resolveClose();
        });
      }),
  );
  return closers;
}

async function main(): Promise<void> {
  const role = process.argv[2];
  if (role !== 'api' && role !== 'worker' && role !== 'gas-tank') {
    process.stderr.write('uso: node main.ts api | worker | gas-tank\n');
    process.exit(2);
  }
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, service: `mtw-${role}` });
  const metrics = createMetrics();
  const closers = await startRole(role, config, logger, metrics);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'cerrando');
    void (async () => {
      for (const close of closers) {
        try {
          await close();
        } catch (error) {
          logger.warn({ err: error }, 'error al cerrar un componente');
        }
      }
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // La configuración inválida se reporta sin valores (ConfigError ya los omite); el resto pasa por el scrubber.
  process.stderr.write(`${scrubString(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}\n`);
  process.exit(1);
});
