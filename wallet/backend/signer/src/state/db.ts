// Conexión a la DB propia del signer [B-SIG-03] (Kysely + pg): una DB lógica por shard, con credenciales propias que
// el backend no tiene. Nunca contiene claves privadas.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { SignerDatabase } from './schema.ts';

export interface SignerDbOptions {
  connectionString: string;
  applicationName: string;
  poolMax?: number;
  onPoolError?: (error: Error) => void;
}

export function createSignerDb(options: SignerDbOptions): Kysely<SignerDatabase> {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 5,
    application_name: options.applicationName,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  return new Kysely<SignerDatabase>({ dialect: new PostgresDialect({ pool }) });
}
