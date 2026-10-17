// Migrador de la DB del signer (Migrator de Kysely). La tabla de control vive en el schema `signer_meta`.
import { Migrator, type MigrationResult } from 'kysely/migration';
import type { Kysely } from 'kysely';
import { MIGRATIONS } from './migrations/index.ts';

export const MIGRATION_SCHEMA = 'signer_meta';

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
    migrationTableSchema: MIGRATION_SCHEMA,
  });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r: MigrationResult) => r.status === 'Error');
  if (error !== undefined || failed) {
    throw new MigrationError(`falló la migración ${failed?.migrationName ?? '(lock o lectura de estado)'}`, {
      cause: error,
    });
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export async function pendingMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
    migrationTableSchema: MIGRATION_SCHEMA,
  });
  const migrations = await migrator.getMigrations();
  return migrations.filter((m) => m.executedAt === undefined).map((m) => m.name);
}
