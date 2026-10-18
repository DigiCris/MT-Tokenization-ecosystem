// Entrypoint del backend: `node main api` (listeners Wallet y Recovery), `node main worker` (dispatcher del outbox,
// emails, worker S de operaciones con su watcher de finalidad, indexer y reconciliación, P13) o `node main gas-tank`
// (recargas de las S y deploys por el shard `platform` del signer, [B-SIG-05]). Cada proceso registra el snapshot de
// policy que cargó (anti-rollback, [B-POL-01]). Cierre ordenado con SIGTERM/SIGINT.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
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
import { AuditWriter } from './audit/audit-writer.ts';
import { GasTankService } from './gas/gas-tank.ts';
import { OpaqueService } from './platform-session/opaque.ts';
import { loadPolicySnapshot, type LoadedPolicySnapshot } from './policy/snapshot.ts';
import { PolicySnapshotStore } from './policy/store.ts';
import { ChainIndexer } from './chain/indexer.ts';
import { Reconciler } from './chain/reconciler.ts';
import { FinalityWatcher } from './chain/watcher.ts';
import { EmailOutbox } from './email/email-outbox.ts';
import { OperationService } from './operations/service.ts';
import { OperationStateMachine } from './operations/state-machine.ts';
import { PlatformSessionIssuer } from './platform-session/token.ts';
import { SafeLease } from './worker/lease.ts';
import { HighValueNotifier } from './send/notifications.ts';
import { SwapCoordinator } from './swap/coordinator.ts';
import { OperationEffects } from './worker/effects.ts';
import { startOperationsWorker } from './worker/main.ts';
import { WhitelistSync } from './whitelist/sync.ts';
import { OperationPipeline } from './worker/pipeline.ts';
import { SovereignModification } from './wallets/sovereign.ts';
import { createAccountServices, createWalletServices } from './services.ts';
import { readSignerTls, SignerClient } from './signer-client/client.ts';
import { SignerKeyService } from './signer-client/sharding.ts';
import { walletDeployJobHandler, WalletDeployer } from './wallets/deployer.ts';
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

/**
 * Registra el snapshot cargado en `policy_snapshots` y rechaza una versión vieja o adulterada (anti-rollback). El
 * snapshot tiene que ser de esta plataforma (el signer exige el mismo platformId en las PlatformSessions).
 */
async function activatePolicy(
  db: Kysely<Database>,
  snapshot: LoadedPolicySnapshot,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  if (snapshot.platformId !== config.platformId) {
    throw new Error(`el snapshot de policy es de la plataforma ${snapshot.platformId}, no de ${config.platformId}`);
  }
  await new PolicySnapshotStore(db).activate(snapshot);
  logger.info({ policyVersion: snapshot.version, sha256: snapshot.sha256 }, 'snapshot de policy activo');
}

async function stuckOperations(db: Kysely<Database>): Promise<number> {
  const row = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM wallet_operations
    WHERE status IN ('QUEUED', 'VALIDATING', 'READY', 'SUBMITTED', 'MINED', 'REORGED', 'CANCEL_REQUESTED')
      AND updated_at < now() - interval '10 minutes'`.execute(db);
  return row.rows[0]?.n ?? 0;
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
    // Onboarding (P12): shards del signer por mTLS y snapshot de policy firmado (direcciones y codehashes).
    const signer = loadSignerClientConfig();
    const snapshot = loadPolicySnapshot(signer.policy.snapshotPath, signer.policy.publicKey, config.appEnv);
    await activatePolicy(db, snapshot, config, logger);
    const tls = readSignerTls(signer.mtls);
    const clients = new Map(
      signer.shards.map((s) => [
        s.id,
        new SignerClient({ shardId: s.id, url: s.url, tls, timeoutMs: signer.timeoutMs }),
      ]),
    );
    closers.push(() => {
      for (const client of clients.values()) client.close();
      return Promise.resolve();
    });
    const onchain = { rpc, snapshot: () => snapshot };
    const services = await createAccountServices({ config, db, redis, outbox, metrics, logger, onchain });
    const wallets = createWalletServices({
      config,
      db,
      account: services,
      onchain,
      signerKeys: new SignerKeyService({ db, shards: signer.shards, clients }),
      outbox,
      metrics,
      logger,
    });
    const api = await startApi({
      config,
      logger,
      metrics,
      db,
      redis,
      rpc,
      idempotency,
      services,
      wallets,
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
    await activatePolicy(db, snapshot, config, logger);
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
    // Deploys de Safes pedidos por la API (cola `gas-tank`, P12.T06–T07): createWallet, verificación y ACTIVE.
    const deployer = new WalletDeployer({
      db,
      rpc,
      gasTank,
      snapshot: () => snapshot,
      opaque: await OpaqueService.create({
        db,
        redis,
        serverSetup: config.secrets.opaqueServerSetup,
        platformId: config.platformId,
      }),
      audit: new AuditWriter(config.secrets.auditChainKey, metrics),
      metrics,
      logger: logger.child({ component: 'wallet-deployer' }),
    });
    const deployConnection = createRedis(
      config.redis.url.reveal(),
      'worker',
      'mtw-gas-tank-deploys',
      throttledWarn(logger, 'error de conexión con Valkey (cola gas-tank)'),
    );
    closers.push(() => deployConnection.quit());
    const deployWorker = createOutboxWorker({
      queue: QUEUES.gasTank,
      connection: deployConnection,
      outbox,
      logger,
      // Las txs de la cuenta gas tank van de a una (lock de la DB): sin concurrencia entre deploys.
      concurrency: 1,
      handler: walletDeployJobHandler(deployer),
    });
    closers.unshift(() => deployWorker.close());
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
    // Worker S de operaciones (P13): pipeline por Safe con lease, watcher de finalidad, indexer y reconciliación.
    const signer = loadSignerClientConfig();
    const snapshot = loadPolicySnapshot(signer.policy.snapshotPath, signer.policy.publicKey, config.appEnv);
    await activatePolicy(db, snapshot, config, logger);
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
    const tls = readSignerTls(signer.mtls);
    const clients = new Map(
      signer.shards.map((s) => [
        s.id,
        new SignerClient({ shardId: s.id, url: s.url, tls, timeoutMs: signer.timeoutMs }),
      ]),
    );
    closers.push(() => {
      for (const client of clients.values()) client.close();
      return Promise.resolve();
    });
    const audit = new AuditWriter(config.secrets.auditChainKey, metrics);
    const machine = new OperationStateMachine({ db, audit, outbox });
    const emails = new EmailOutbox(outbox, config.secrets.fieldEncryptionKey);
    const sovereign = new SovereignModification({
      audit,
      email: emails,
      logger: logger.child({ component: 'sovereign' }),
      metrics,
    });
    const workerId = `${hostname()}:${String(process.pid)}:${randomBytes(4).toString('hex')}`;
    const pipeline = new OperationPipeline({
      db,
      machine,
      audit,
      rpc,
      snapshot: () => snapshot,
      signers: new SignerKeyService({ db, shards: signer.shards, clients }),
      issuer: await PlatformSessionIssuer.create(
        config.secrets.sessionIssuerPrivateKey,
        config.secrets.sessionIssuerPublicKey,
      ),
      sovereign,
      lease: new SafeLease(db, workerId, { ttlMs: config.worker.leaseTtlMs }),
      logger: logger.child({ component: 'operation-pipeline', workerId }),
      metrics,
      options: {
        receiptTimeoutMs: config.worker.receiptTimeoutMs,
        maxReplacements: config.worker.maxReplacements,
        retry: config.worker.retry,
      },
    });
    // Efectos de P14: whitelist desde los eventos on-chain, grupos de swap y avisos de alto valor.
    const whitelistSync = new WhitelistSync({
      db,
      rpc,
      audit,
      emails,
      snapshot: () => snapshot,
      logger: logger.child({ component: 'whitelist-sync' }),
      metrics,
    });
    const swapCoordinator = new SwapCoordinator({
      db,
      machine,
      audit,
      rpc,
      snapshot: () => snapshot,
      logger: logger.child({ component: 'swap-coordinator' }),
      metrics,
    });
    const highValue = new HighValueNotifier({ db, emails, metrics });
    const effects = new OperationEffects(
      [
        { name: 'whitelist', runOnce: () => whitelistSync.runOnce() },
        { name: 'swap-groups', runOnce: () => swapCoordinator.runOnce() },
        { name: 'high-value', runOnce: () => highValue.runOnce() },
      ],
      logger.child({ component: 'operation-effects' }),
    );
    const operationsConnection = createRedis(
      config.redis.url.reveal(),
      'worker',
      'mtw-worker-operations',
      throttledWarn(logger, 'error de conexión con Valkey (cola wallet-operations)'),
    );
    closers.push(() => operationsConnection.quit());
    const operationsWorker = startOperationsWorker({
      db,
      connection: operationsConnection,
      outbox,
      machine,
      pipeline,
      operations: new OperationService({
        db,
        machine,
        audit,
        rpc,
        snapshot: () => snapshot,
        sovereign,
        logger: logger.child({ component: 'operations' }),
        metrics,
      }),
      watcher: new FinalityWatcher({
        db,
        machine,
        audit,
        rpc,
        confirmations: config.confirmations,
        logger: logger.child({ component: 'finality-watcher' }),
        metrics,
      }),
      indexer: new ChainIndexer({
        db,
        rpc,
        audit,
        snapshot: () => snapshot,
        confirmations: config.confirmations,
        logger: logger.child({ component: 'chain-indexer' }),
        metrics,
      }),
      reconciler: new Reconciler({
        db,
        rpc,
        audit,
        snapshot: () => snapshot,
        sovereign,
        logger: logger.child({ component: 'reconciler' }),
        metrics,
      }),
      effects,
      logger,
      metrics,
      options: {
        concurrency: config.worker.concurrency,
        watcherIntervalMs: config.worker.watcherIntervalMs,
        indexerIntervalMs: config.worker.indexerIntervalMs,
        reconcilerIntervalMs: config.worker.reconcilerIntervalMs,
        effectsIntervalMs: config.worker.effectsIntervalMs,
      },
    });
    closers.unshift(() => operationsWorker.close());
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
      operationsByStatus: () => operationsByStatus(db),
      stuckOperations: () => stuckOperations(db),
    });
    metricsServer = await startMetricsServer(metrics.registry, config.metrics.bindHost, config.metrics.workerPort);
    logger.info(
      {
        metricsPort: config.metrics.workerPort,
        emailProvider: provider.name,
        workerId,
        policyVersion: snapshot.version,
      },
      'worker iniciado (outbox, email y operaciones)',
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
