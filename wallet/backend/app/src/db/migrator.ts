// Migraciones con el Migrator de Kysely (SQL explícito, sin "down"; patrón expand/contract). Las tablas del
// migrador viven en el schema mtw_meta: mtw_app sólo puede leerlas.
import { sql, type Kysely } from 'kysely';
import { Migrator, type MigrationResult } from 'kysely/migration';
import { MIGRATIONS } from './migrations/index.ts';

export const MIGRATION_SCHEMA = 'mtw_meta';
const MIGRATION_TABLE = 'kysely_migration';

export class MigrationError extends Error {
  override name = 'MigrationError';
}

function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
    migrationTableSchema: MIGRATION_SCHEMA,
  });
}

/** Aplica las migraciones pendientes (idempotente). Devuelve los nombres aplicados en esta corrida. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  const failed = results?.find((r: MigrationResult) => r.status === 'Error');
  if (error !== undefined || failed) {
    throw new MigrationError(`falló la migración ${failed?.migrationName ?? '(lock o lectura de estado)'}`, {
      cause: error,
    });
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export interface MigrationState {
  name: string;
  executedAt: Date | null;
}

export interface MigrationStatus {
  /** Migraciones que conoce esta versión, con su fecha de aplicación (null = pendiente). */
  known: MigrationState[];
  /**
   * Migraciones aplicadas que esta versión no conoce (una versión más nueva ya migró). Con expand/contract la versión
   * anterior sigue funcionando sobre ese esquema: esto permite volver atrás la aplicación sin "down".
   */
  newer: string[];
}

/** Estado de las migraciones con una lectura simple (sirve con el rol mtw_app, sin DDL). */
export async function migrationStatus<DB>(db: Kysely<DB>): Promise<MigrationStatus> {
  const exists = await sql<{ present: boolean }>`
    SELECT to_regclass(${`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`}) IS NOT NULL AS present`.execute(db);
  const executed = new Map<string, Date>();
  if (exists.rows[0]?.present) {
    const rows = await sql<{ name: string; timestamp: string }>`
      SELECT name, timestamp FROM ${sql.table(`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`)}`.execute(db);
    for (const row of rows.rows) executed.set(row.name, new Date(row.timestamp));
  }
  const known = Object.keys(MIGRATIONS).sort();
  return {
    known: known.map((name) => ({ name, executedAt: executed.get(name) ?? null })),
    newer: [...executed.keys()].filter((name) => !known.includes(name)).sort(),
  };
}

export async function pendingMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  return (await migrationStatus(db)).known.filter((m) => m.executedAt === null).map((m) => m.name);
}
