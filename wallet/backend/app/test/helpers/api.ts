// Listeners de la API armados con dependencias reales (base de test, Valkey de Testcontainers, RPC del fork o uno
// inalcanzable cuando el test no toca la cadena).
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { buildListener, type ApiInstance, type RouteRegistrar } from '../../src/api/server.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import type { AppConfig } from '../../src/config/env.ts';
import { IdempotencyRepository } from '../../src/db/repositories/idempotency-repository.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import type { Client } from '../../src/db/schema.ts';
import { createLogger, type Logger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { createAccountServices, type AccountServices } from '../../src/services.ts';
import { TestClient } from './client.ts';
import type { TestDatabase } from './db.ts';
import { testConfig } from './config.ts';

export interface TestListenerOptions {
  db: TestDatabase;
  client?: Client;
  config?: AppConfig;
  configOverrides?: Record<string, string | undefined>;
  logger?: Logger;
  metrics?: Metrics;
  redis?: Redis;
  rpc?: RpcQuorumClient;
  extraRoutes?: RouteRegistrar;
}

export interface TestListener {
  app: ApiInstance;
  client: Client;
  /** Origin del frontend del listener (el único que acepta su CORS). */
  origin: string;
  config: AppConfig;
  metrics: Metrics;
  redis: Redis;
  rpc: RpcQuorumClient;
  services: AccountServices;
  /** Cliente tipo navegador (cookies, Origin y CSRF) contra este listener. */
  newClient: (remoteAddress?: string) => TestClient;
  close: () => Promise<void>;
}

/** URL de Valkey con un índice de base propio (un archivo de test puede hacer FLUSHDB sin tocar a los demás). */
export function testRedisUrl(database = 0): string {
  return inject('redisUrl').replace(/\/\d+$/, `/${database}`);
}

export function testRedis(database = 0): Redis {
  return new Redis(testRedisUrl(database), { maxRetriesPerRequest: 3, connectionName: 'test' });
}

export function unreachableRpc(logger: Logger, metrics: Metrics): RpcQuorumClient {
  return new RpcQuorumClient({
    primaryUrl: 'http://127.0.0.1:9',
    secondaryUrl: 'http://127.0.0.1:9',
    mode: 'local-single',
    chainId: 8453,
    timeoutMs: 500,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 0,
    backoffMs: 10,
    logger,
    metrics,
  });
}

export async function buildTestListener(options: TestListenerOptions): Promise<TestListener> {
  // Límite global alto por defecto: los archivos de test comparten Valkey e IP; los tests de rate limit lo fijan.
  const config = options.config ?? testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000', ...options.configOverrides });
  const logger = options.logger ?? createLogger({ level: 'silent', service: 'test' });
  const metrics = options.metrics ?? createMetrics({ defaultMetrics: false });
  const ownRedis = options.redis === undefined;
  const redis = options.redis ?? testRedis();
  const rpc = options.rpc ?? unreachableRpc(logger, metrics);
  const services = createAccountServices({
    config,
    db: options.db.app,
    redis,
    outbox: new OutboxRepository(options.db.app),
    metrics,
    logger,
  });
  const client = options.client ?? 'WALLET';
  const origin = client === 'WALLET' ? config.api.walletOrigin : config.api.recoveryOrigin;
  const app = await buildListener(
    client,
    {
      config,
      logger,
      metrics,
      db: options.db.app,
      redis,
      rpc,
      idempotency: new IdempotencyRepository(options.db.app),
      sessions: services.sessions,
      account: services.account,
      version: '0.0.0-test',
    },
    options.extraRoutes,
  );
  return {
    app,
    client,
    origin,
    config,
    metrics,
    redis,
    rpc,
    services,
    newClient: (remoteAddress?: string) => new TestClient(app, origin, remoteAddress),
    close: async () => {
      await app.close();
      if (ownRedis) await redis.quit();
    },
  };
}
