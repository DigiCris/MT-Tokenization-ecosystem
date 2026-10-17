// Utilidades de las CLIs del ciclo de vida: salida JSON en stdout (sin secretos), errores en stderr y código 1.
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, loadShardConfig, type ShardConfig } from '../config/env.ts';
import { createLogger, type Logger } from '../observability/logger.ts';
import { createSignerDb } from '../state/db.ts';
import type { Kysely } from 'kysely';
import type { SignerDatabase } from '../state/schema.ts';

export function fail(message: string): never {
  process.stderr.write(`signer: ${message}\n`);
  process.exit(1);
}

export function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
}

export function args<T extends NonNullable<ParseArgsConfig['options']>>(options: T) {
  return parseArgs({ options, allowPositionals: true, args: process.argv.slice(2).filter((a) => a !== '--') });
}

export interface ShardContext {
  config: ShardConfig;
  db: Kysely<SignerDatabase>;
  logger: Logger;
  close: () => Promise<void>;
}

export function shardContext(options: { shard?: string | undefined; prefix?: string } = {}): ShardContext {
  let config: ShardConfig;
  try {
    config = loadShardConfig({
      ...(options.shard === undefined ? {} : { shard: options.shard }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  const db = createSignerDb({ connectionString: config.databaseUrl.reveal(), applicationName: 'mtw-signer-lifecycle' });
  const logger = createLogger({ level: 'warn', service: 'signer-lifecycle', shardId: config.shardId });
  return { config, db, logger, close: () => db.destroy() };
}

export async function run(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    fail(error instanceof Error ? `${error.name}: ${error.message}` : 'error desconocido');
  }
}
