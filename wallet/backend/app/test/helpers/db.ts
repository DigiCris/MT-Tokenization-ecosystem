// Una base propia por archivo de test, clonada de la plantilla migrada (o de la base inicial sin migrar).
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase } from '../../src/db/kysely.ts';
import type { Database } from '../../src/db/schema.ts';

export interface TestDatabase {
  name: string;
  appUrl: string;
  migratorUrl: string;
  /** Rol mtw_app (DML), el que usa la aplicación. */
  app: Kysely<Database>;
  /** Rol mtw_migrator (dueño de los objetos). */
  migrator: Kysely<Database>;
  /** Superusuario (sólo para preparar escenarios: simular manipulación directa, etc.). */
  admin: pg.Client;
  close: () => Promise<void>;
}

function adminClient(database: string): pg.Client {
  const info = inject('pg');
  return new pg.Client({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: info.adminPassword,
    database,
  });
}

export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const info = inject('pg');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const template = options.migrated === false ? 'mtw_wallet' : 'mtw_template';
  const root = adminClient('postgres');
  await root.connect();
  await root.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER mtw_migrator`);
  await root.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  await root.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO mtw_app`);
  await root.query(`GRANT CONNECT ON DATABASE ${name} TO mtw_readonly`);
  await root.end();

  const appUrl = `postgres://mtw_app:${info.appPassword}@${info.host}:${info.port}/${name}`;
  const migratorUrl = `postgres://mtw_migrator:${info.migratorPassword}@${info.host}:${info.port}/${name}`;
  const app = createDatabase({ connectionString: appUrl, applicationName: 'test-app', poolMax: 10 });
  const migrator = createDatabase({ connectionString: migratorUrl, applicationName: 'test-migrator', poolMax: 4 });
  const admin = adminClient(name);
  await admin.connect();
  return {
    name,
    appUrl,
    migratorUrl,
    app,
    migrator,
    admin,
    close: async () => {
      await Promise.all([app.destroy(), migrator.destroy(), admin.end()]);
      const cleanup = adminClient('postgres');
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Inserta un usuario mínimo (las tablas con FK a users lo necesitan). */
export async function insertUser(
  db: Kysely<Database>,
  email = `u${randomBytes(4).toString('hex')}@test.invalid`,
): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ platform_id: 'mt-test', email, password_hash: 'argon2id$test', pepper_version: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
