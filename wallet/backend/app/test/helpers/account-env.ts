// Entorno de los tests de cuenta: base propia, listeners de Wallet (y opcionalmente Recovery) con los servicios reales,
// Valkey en una base propia del archivo (rate limit, riesgo de login y colas) y el pipeline de email real hacia Mailpit.
import type { Redis } from 'ioredis';
import type { EmailProvider } from '../../src/email/provider.ts';
import type { Logger } from '../../src/observability/logger.ts';
import { buildTestListener, testRedis, type TestListener } from './api.ts';
import { testConfig } from './config.ts';
import { createTestDatabase, type TestDatabase } from './db.ts';
import { startEmailPipeline, type EmailPipeline } from './email-pipeline.ts';

export interface AccountEnv {
  db: TestDatabase;
  redis: Redis;
  wallet: TestListener;
  recovery: TestListener;
  pipeline: EmailPipeline;
  close: () => Promise<void>;
}

export async function startAccountEnv(options: {
  redisDb: number;
  configOverrides?: Record<string, string | undefined>;
  /** Proveedor de email del worker (por defecto SMTP de Mailpit; los tests live usan Mailgun real). */
  provider?: EmailProvider;
  /** Logger de los listeners y del worker (por defecto silencioso). */
  logger?: Logger;
}): Promise<AccountEnv> {
  const db = await createTestDatabase();
  const redis = testRedis(options.redisDb);
  await redis.flushdb();
  // Una sola configuración (mismos secretos) para los dos listeners, como el proceso `api`.
  const config = testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000', ...options.configOverrides });
  const logger = options.logger === undefined ? {} : { logger: options.logger };
  const wallet = await buildTestListener({ db, client: 'WALLET', config, redis, ...logger });
  const recovery = await buildTestListener({ db, client: 'RECOVERY', config, redis, ...logger });
  const pipeline = await startEmailPipeline({
    db: db.app,
    redisDb: options.redisDb,
    fieldKey: config.secrets.fieldEncryptionKey,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...logger,
  });
  return {
    db,
    redis,
    wallet,
    recovery,
    pipeline,
    close: async () => {
      await pipeline.stop();
      await wallet.close();
      await recovery.close();
      await redis.quit();
      await db.close();
    },
  };
}
