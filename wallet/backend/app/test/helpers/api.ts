// Listeners de la API armados con dependencias reales (base de test, Valkey de Testcontainers, RPC del fork o uno
// inalcanzable cuando el test no toca la cadena).
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { buildListener, type ApiInstance, type RouteRegistrar } from '../../src/api/server.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import type { AppConfig } from '../../src/config/env.ts';
import { IdempotencyRepository } from '../../src/db/repositories/idempotency-repository.ts';
import type { Client } from '../../src/db/schema.ts';
import { createLogger, type Logger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
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
  config: AppConfig;
  metrics: Metrics;
  redis: Redis;
  rpc: RpcQuorumClient;
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
  const config = options.config ?? testConfig(options.configOverrides);
  const logger = options.logger ?? createLogger({ level: 'silent', service: 'test' });
  const metrics = options.metrics ?? createMetrics({ defaultMetrics: false });
  const ownRedis = options.redis === undefined;
  const redis = options.redis ?? testRedis();
  const rpc = options.rpc ?? unreachableRpc(logger, metrics);
  const app = await buildListener(
    options.client ?? 'WALLET',
    {
      config,
      logger,
      metrics,
      db: options.db.app,
      redis,
      rpc,
      idempotency: new IdempotencyRepository(options.db.app),
      version: '0.0.0-test',
    },
    options.extraRoutes,
  );
  return {
    app,
    config,
    metrics,
    redis,
    rpc,
    close: async () => {
      await app.close();
      if (ownRedis) await redis.quit();
    },
  };
}
