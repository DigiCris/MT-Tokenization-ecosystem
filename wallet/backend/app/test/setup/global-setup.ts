// Infraestructura real para los tests de integración: PostgreSQL 18 y Valkey 9 con las mismas imágenes fijadas por
// digest que el stack local (scripts/tools/versions.json) y el mismo init de roles (infra/local/postgres/init-db.sh).
// Se crea `mtw_template` (copia de la base inicial, ya migrada): cada archivo de test clona su propia base desde ahí.
//
// Además (salvo que sólo corra el proyecto `live`), el sistema se despliega una vez en un fork de Base con los scripts
// reales (`scripts/deploy-core ci`) y su estado se vuelca con `anvil_dumpState`: cada archivo que lo necesita levanta
// su propio Anvil con `--load-state` (test/helpers/deploy.ts → deployedChain()).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/db/kysely.ts';
import { migrateToLatest } from '../../src/db/migrator.ts';
import { deploySystem, type DeployedChain } from '../helpers/deploy.ts';
import { startAnvil } from '../helpers/fork.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');

export interface PgInfo {
  host: string;
  port: number;
  containerId: string;
  adminUser: string;
  adminPassword: string;
  appPassword: string;
  migratorPassword: string;
  /** Rol mtw_signer (infra/local/postgres/init-db.sh): las DBs de los shards del signer de los tests de integración. */
  signerPassword: string;
}

export interface MailpitInfo {
  smtpHost: string;
  smtpPort: number;
  apiUrl: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: PgInfo;
    redisUrl: string;
    mailpit: MailpitInfo;
    /** Sistema desplegado en el fork (null si sólo corre el proyecto `live`). */
    chain: DeployedChain | null;
  }
}

/** Despliega el sistema en un Anvil efímero y vuelca su estado; devuelve también cómo limpiarlo. */
async function deployChain(): Promise<{ chain: DeployedChain; cleanup: () => void }> {
  const anvil = await startAnvil();
  const dir = mkdtempSync(join(tmpdir(), 'mtw-backend-chain-'));
  try {
    const system = await deploySystem(anvil.url);
    const hex = await anvil.rpc<string>('anvil_dumpState');
    const raw = Buffer.from(hex.slice(2), 'hex');
    let json: Buffer;
    try {
      json = gunzipSync(raw);
    } catch {
      json = raw;
    }
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, json);
    return {
      chain: { statePath, system },
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    await anvil.stop();
  }
}

const secret = () => randomBytes(24).toString('hex');

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const versions = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')) as {
    images: { postgres: string; valkey: string; mailpit: string };
  };
  const adminPassword = secret();
  const appPassword = secret();
  const migratorPassword = secret();
  const signerPassword = secret();
  const redisPassword = secret();

  // El deploy (minutos) corre en paralelo con los contenedores; sólo hace falta si corre algo más que `live`.
  const needsChain = project.vitest.projects.some((p) => p.name !== 'live');
  const chainPromise = needsChain ? deployChain() : Promise.resolve(null);
  // Si los contenedores fallan, el deploy igual se espera (y limpia) antes de propagar el error.
  chainPromise.catch(() => undefined);

  const [postgres, valkey, mailpit] = await Promise.all([
    new PostgreSqlContainer(versions.images.postgres)
      .withDatabase('mtw_wallet')
      .withUsername('mtw_admin')
      .withPassword(adminPassword)
      .withEnvironment({
        MTW_APP_DB_PASSWORD: appPassword,
        MTW_MIGRATOR_DB_PASSWORD: migratorPassword,
        MTW_SIGNER_DB_PASSWORD: signerPassword,
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
        // Una base por archivo de test (test/helpers/redis-dbs.ts).
        '--databases',
        '64',
        '--requirepass',
        redisPassword,
      ])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
    // Mailpit: SMTP real local y su API para leer los emails que envía el worker. Sólo acepta destinatarios de
    // test.invalid: cualquier otro recibe un 550 real (los tests de rechazo definitivo lo usan).
    new GenericContainer(versions.images.mailpit)
      .withEnvironment({
        MP_SMTP_AUTH_ACCEPT_ANY: '1',
        MP_SMTP_AUTH_ALLOW_INSECURE: '1',
        MP_MAX_MESSAGES: '5000',
        MP_SMTP_ALLOWED_RECIPIENTS: '@([a-z0-9-]+\\.)*test\\.invalid$',
      })
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
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
    signerPassword,
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

  const deployed = await chainPromise;
  project.provide('chain', deployed?.chain ?? null);
  project.provide('pg', info);
  project.provide('redisUrl', `redis://:${redisPassword}@${valkey.getHost()}:${valkey.getMappedPort(6379)}/0`);
  project.provide('mailpit', {
    smtpHost: mailpit.getHost(),
    smtpPort: mailpit.getMappedPort(1025),
    apiUrl: `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`,
  });

  return async () => {
    deployed?.cleanup();
    await Promise.all([postgres.stop(), valkey.stop(), mailpit.stop()]);
  };
}
