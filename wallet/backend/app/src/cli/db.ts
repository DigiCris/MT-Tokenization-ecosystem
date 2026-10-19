// CLI de base de datos (P08.T03): `pnpm db:migrate | db:status | db:backup | db:restore`.
//
//   db:migrate                     aplica las migraciones pendientes (rol mtw_migrator; idempotente)
//   db:status [--check]            lista las migraciones; con --check sale con 1 si hay pendientes
//   db:backup [--out <archivo>]    pg_dump de la base local (default: wallet/.backups/<base>-<fecha>.dump)
//   db:restore --file <archivo> --confirm <base>
//                                  pg_restore --clean en una transacción sobre la base local
//
// Backup/restore son sólo para APP_ENV=local: staging y producción usan pgBackRest (ADR-031).
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMigrationConfig, WALLET_ROOT } from '../config/env.ts';
import { backupDatabase, composePostgresContainer, restoreDatabase, type PgTarget } from '../db/backup.ts';
import { createDatabase } from '../db/kysely.ts';
import { migrateToLatest, migrationStatus } from '../db/migrator.ts';
import { scrubString } from '../observability/redaction.ts';

const out = (line: string) => process.stdout.write(`${line}\n`);

async function withMigratorDb<T>(fn: (db: ReturnType<typeof createDatabase<unknown>>) => Promise<T>): Promise<T> {
  const config = loadMigrationConfig();
  const db = createDatabase<unknown>({ connectionString: config.migrationUrl.reveal(), applicationName: 'mtw-db-cli' });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

async function localTarget(container?: string): Promise<PgTarget> {
  const config = loadMigrationConfig();
  if (config.appEnv !== 'local') {
    throw new Error(
      `db:backup/db:restore sólo corren con APP_ENV=local; en ${config.appEnv} los backups son con pgBackRest (ADR-031)`,
    );
  }
  const url = new URL(config.migrationUrl.reveal());
  return {
    container: container ?? (await composePostgresContainer(join(WALLET_ROOT, 'docker-compose.yml'))),
    user: decodeURIComponent(url.username),
    database: url.pathname.replace(/^\//, ''),
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      check: { type: 'boolean', default: false },
      out: { type: 'string' },
      file: { type: 'string' },
      confirm: { type: 'string' },
      container: { type: 'string' },
    },
    allowPositionals: false,
  });

  switch (command) {
    case 'migrate': {
      const applied = await withMigratorDb(migrateToLatest);
      out(applied.length === 0 ? 'migraciones al día (nada que aplicar)' : `aplicadas: ${applied.join(', ')}`);
      return;
    }
    case 'status': {
      const status = await withMigratorDb(migrationStatus);
      for (const m of status.known)
        out(`${m.executedAt ? m.executedAt.toISOString() : 'PENDIENTE'.padEnd(24)}  ${m.name}`);
      for (const name of status.newer) out(`${'MÁS NUEVA'.padEnd(24)}  ${name} (aplicada por una versión posterior)`);
      const pending = status.known.filter((m) => m.executedAt === null).length;
      out(pending === 0 ? 'estado: al día' : `estado: ${pending} pendiente(s)`);
      if (values.check && pending > 0) process.exitCode = 1;
      return;
    }
    case 'backup': {
      const target = await localTarget(values.container);
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const file = values.out ? resolve(values.out) : join(WALLET_ROOT, '.backups', `${target.database}-${stamp}.dump`);
      mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
      await backupDatabase(target, file);
      out(`backup escrito: ${file}`);
      return;
    }
    case 'restore': {
      const target = await localTarget(values.container);
      if (!values.file) throw new Error('falta --file <archivo>');
      if (values.confirm !== target.database) {
        throw new Error(`el restore reemplaza la base: confirmar con --confirm ${target.database}`);
      }
      await restoreDatabase(target, resolve(values.file));
      out(`restore aplicado sobre ${target.database}`);
      return;
    }
    case undefined:
    default:
      process.stderr.write(
        'uso: db.ts migrate | status [--check] | backup [--out f] | restore --file f --confirm base\n',
      );
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // La causa (p. ej. la conexión rechazada detrás de "lock o lectura de estado"), también sin secretos.
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : undefined;
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  process.stderr.write(`${scrubString(detail === '' ? message : `${message}: ${detail}`)}\n`);
  process.exitCode = 1;
});
