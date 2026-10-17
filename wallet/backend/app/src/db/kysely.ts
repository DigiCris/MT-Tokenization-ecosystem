// Conexión a PostgreSQL (Kysely + pg). La API y el worker usan el rol mtw_app (DML); las migraciones, mtw_migrator.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export interface DatabaseOptions {
  connectionString: string;
  poolMax?: number;
  applicationName: string;
  /** Recibe errores de clientes inactivos del pool (sin esto, un corte de red tira el proceso). */
  onPoolError?: (error: Error) => void;
}

export function createPool(options: DatabaseOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: options.applicationName,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  return pool;
}

export function createDatabase<DB = Database>(options: DatabaseOptions): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: createPool(options) }) });
}
