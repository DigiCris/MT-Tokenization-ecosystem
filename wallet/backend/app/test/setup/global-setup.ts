// Infraestructura real para los tests de integración: PostgreSQL 18 y Valkey 9 con las mismas imágenes fijadas por
// digest que el stack local (scripts/tools/versions.json) y el mismo init de roles (infra/local/postgres/init-db.sh).
// Se crea `mtw_template` (copia de la base inicial, ya migrada): cada archivo de test clona su propia base desde ahí.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/db/kysely.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

export interface PgInfo {
  host: string;
  port: number;
  containerId: string;
  adminUser: string;
  adminPassword: string;
  appPassword: string;
  migratorPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: PgInfo;
    redisUrl: string;
  }
}

const secret = () => randomBytes(24).toString('hex');

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const versions = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')) as {
    images: { postgres: string; valkey: string };
  };
  const adminPassword = secret();
  const appPassword = secret();
  const migratorPassword = secret();
  const redisPassword = secret();

  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer(versions.images.postgres)
      .withDatabase('mtw_wallet')
      .withUsername('mtw_admin')
      .withPassword(adminPassword)
      .withEnvironment({
        MTW_APP_DB_PASSWORD: appPassword,
        MTW_MIGRATOR_DB_PASSWORD: migratorPassword,
        MTW_SIGNER_DB_PASSWORD: secret(),
      })
      .withCopyFilesToContainer([
        {
          source: resolve(WALLET_ROOT, 'infra/local/postgres/init-db.sh'),
          target: '/docker-entrypoint-initdb.d/10-init-db.sh',
          mode: 0o755,
        },
      ])
      .start(),
    new GenericContainer(versions.images.valkey)
      .withCommand([
        'valkey-server',
        '--appendonly',
        'yes',
        '--maxmemory-policy',
        'noeviction',
        '--requirepass',
        redisPassword,
      ])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);

  const info: PgInfo = {
    host: postgres.getHost(),
    port: postgres.getPort(),
    containerId: postgres.getId(),
    adminUser: 'mtw_admin',
    adminPassword,
    appPassword,
    migratorPassword,
  };

  // Base plantilla migrada (con el rol mtw_migrator, igual que en producción).
  const admin = new pg.Client({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: adminPassword,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query('CREATE DATABASE mtw_template TEMPLATE mtw_wallet OWNER mtw_migrator');
  await admin.end();
  const migrator = createDatabase<unknown>({
    connectionString: `postgres://mtw_migrator:${migratorPassword}@${info.host}:${info.port}/mtw_template`,
    applicationName: 'test-global-setup',
  });
  await migrateToLatest(migrator);
  await migrator.destroy();

  project.provide('pg', info);
  project.provide('redisUrl', `redis://:${redisPassword}@${valkey.getHost()}:${valkey.getMappedPort(6379)}/0`);

  return async () => {
    await Promise.all([postgres.stop(), valkey.stop()]);
  };
}
