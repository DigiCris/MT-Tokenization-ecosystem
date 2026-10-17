// P08.T03: CLI de base de datos (`db:migrate`, `db:status`) como procesos reales y backup/restore lógico dentro del
// contenedor de PostgreSQL 18 (pg_dump/pg_restore de la misma versión que el servidor).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { backupDatabase, restoreDatabase } from '../../src/db/backup.ts';
import { createTestDatabase, insertUser, type TestDatabase } from '../helpers/db.ts';

const APP = resolve(import.meta.dirname, '../..');

function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ['src/cli/db.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, MTW_ENV_FILE: '/dev/null', ...env },
  });
}

let fresh: TestDatabase;
let dir: string;
beforeAll(async () => {
  fresh = await createTestDatabase({ migrated: false });
  dir = mkdtempSync(join(tmpdir(), 'mtw-backup-'));
});
afterAll(async () => {
  await fresh.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('db:migrate y db:status', () => {
  it('status --check falla con pendientes; migrate aplica; status queda al día', () => {
    const env = { APP_ENV: 'local', DATABASE_MIGRATION_URL: fresh.migratorUrl };
    const before = cli(['status', '--check'], env);
    expect(before.status).toBe(1);
    expect(before.stdout).toContain('PENDIENTE');
    const migrate = cli(['migrate'], env);
    expect(migrate.stderr).toBe('');
    expect(migrate.stdout).toContain('aplicadas: 0001_initial_schema');
    expect(cli(['migrate'], env).stdout).toContain('migraciones al día');
    const after = cli(['status', '--check'], env);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('estado: al día');
    expect(after.stdout + after.stderr).not.toContain(inject('pg').migratorPassword);
  });

  it('sin configuración válida falla sin mostrar valores', () => {
    const result = cli(['migrate'], { APP_ENV: 'local', DATABASE_MIGRATION_URL: 'postgres://mtw_migrator:corta@db/x' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_MIGRATION_URL: el password es demasiado corto');
    expect(result.stderr).not.toContain('corta@');
  });

  it('backup/restore se niegan fuera de APP_ENV=local (pgBackRest, ADR-031)', () => {
    const secretFile = join(dir, 'migration-url');
    writeFileSync(secretFile, fresh.migratorUrl, { mode: 0o600 });
    const result = cli(['backup'], { APP_ENV: 'staging', DATABASE_MIGRATION_URL_FILE: secretFile });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sólo corren con APP_ENV=local; en staging los backups son con pgBackRest (ADR-031)',
    );
  });

  it('restore exige confirmar el nombre de la base', () => {
    const result = cli(['restore', '--file', join(dir, 'x.dump'), '--container', inject('pg').containerId], {
      APP_ENV: 'local',
      DATABASE_MIGRATION_URL: fresh.migratorUrl,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--confirm ${fresh.name}`);
  });
});

describe('contenedor del compose local', () => {
  it('falla con un mensaje claro si el servicio postgres no está corriendo', async () => {
    const { composePostgresContainer } = await import('../../src/db/backup.ts');
    const compose = join(dir, 'docker-compose.yml');
    writeFileSync(compose, 'name: mtw-test-sin-correr\nservices:\n  postgres:\n    image: postgres:18.6\n');
    await expect(composePostgresContainer(compose)).rejects.toThrow(
      'el contenedor postgres del docker compose local no está corriendo',
    );
  });
});

describe('backup y restore lógico', () => {
  it('restaura exactamente el contenido y conserva triggers y permisos', async () => {
    const db = await createTestDatabase();
    try {
      const target = { container: inject('pg').containerId, user: 'mtw_migrator', database: db.name };
      const userId = await insertUser(db.app, `backup${randomBytes(3).toString('hex')}@test.invalid`);
      // Un evento de auditoría: el trigger append-only por fila sólo se dispara si la tabla tiene filas.
      await sql`INSERT INTO audit_events (occurred_at, actor_type, event_type, prev_hash, entry_hash)
                VALUES (now(), 'SYSTEM', 'BACKUP_TEST', ${Buffer.alloc(32)}, ${randomBytes(32)})`.execute(db.app);
      const file = join(dir, `${db.name}.dump`);
      await backupDatabase(target, file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(file).size).toBeGreaterThan(1000);

      await insertUser(db.app, 'despues-del-backup@test.invalid');
      await sql`DELETE FROM users WHERE id = ${userId}`.execute(db.app);
      await restoreDatabase(target, file);

      const emails = (await db.app.selectFrom('users').select('email').execute()).map((r) => r.email);
      expect(emails).toHaveLength(1);
      expect(emails[0]).toMatch(/^backup/);
      // El trigger append-only y los GRANTs sobreviven al restore.
      const update = await sql`UPDATE audit_events SET event_type = 'X_EVENT'`.execute(db.migrator).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(update).toBe('42501');
      const appUpdate = await sql`UPDATE audit_events SET event_type = 'X_EVENT'`.execute(db.app).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(appUpdate).toBe('42501');
    } finally {
      await db.close();
    }
  });

  it('un archivo inválido no altera la base (restore en una sola transacción)', async () => {
    const db = await createTestDatabase();
    try {
      await insertUser(db.app, 'intacto@test.invalid');
      const bogus = join(dir, 'bogus.dump');
      writeFileSync(bogus, 'no es un dump de pg_dump');
      await expect(
        restoreDatabase({ container: inject('pg').containerId, user: 'mtw_migrator', database: db.name }, bogus),
      ).rejects.toThrow(/pg_restore terminó/);
      const emails = (await db.app.selectFrom('users').select('email').execute()).map((r) => r.email);
      expect(emails).toEqual(['intacto@test.invalid']);
    } finally {
      await db.close();
    }
  });
});
