// Infraestructura real de los tests del signer, una vez por corrida:
//
// - PostgreSQL 18 (misma imagen fijada por digest que el stack local) con el rol `mtw_signer` y una base template ya
//   migrada (`mtw_signer_template`): cada archivo de test clona la suya.
// - Fork de Base en Anvil con el sistema desplegado por los scripts reales (`scripts/deploy-core ci`, LOCAL_SEED
//   aleatoria, JSON en `contracts/deployments/ci-<tag>.json` que se borra al leerlo) y su estado volcado con
//   `anvil_dumpState`: cada archivo levanta su propio Anvil con `--load-state` (aislado y sin redesplegar).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createSignerDb } from '../../src/state/db.ts';
import { migrateToLatest } from '../../src/state/migrator.ts';
import { startAnvil } from '../helpers/anvil.ts';
import { forkUpstreamUrl, pinnedImages, WALLET_ROOT } from '../helpers/paths.ts';

export interface PgInfo {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  signerPassword: string;
}

export interface DeployedSystem {
  chainId: number;
  forkBlock: number;
  /** Direcciones del sistema (contracts/deployments/<red>.json → contracts). */
  contracts: Record<string, string>;
  /** Runtime codehash de cada contrato del sistema (mismas claves). */
  codehashes: Record<string, string>;
  policy: { admin: string; mode: string; guardians: string[] };
}

export interface ChainInfo {
  statePath: string;
  system: DeployedSystem;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pg: PgInfo;
    chain: ChainInfo;
  }
}

const secret = () => randomBytes(24).toString('hex');

async function startPostgres() {
  const adminPassword = secret();
  const signerPassword = secret();
  const container = await new PostgreSqlContainer(pinnedImages().postgres)
    .withDatabase('postgres')
    .withUsername('mtw_admin')
    .withPassword(adminPassword)
    .start();
  const admin = new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    user: 'mtw_admin',
    password: adminPassword,
    database: 'postgres',
  });
  await admin.connect();
  // Igual que infra/local/postgres/init-db.sh: rol propio del signer, dueño de su base.
  await admin.query(`CREATE ROLE mtw_signer LOGIN PASSWORD '${signerPassword}'`);
  await admin.query('CREATE DATABASE mtw_signer_template OWNER mtw_signer');
  await admin.end();
  const template = new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    user: 'mtw_admin',
    password: adminPassword,
    database: 'mtw_signer_template',
  });
  await template.connect();
  await template.query('ALTER SCHEMA public OWNER TO mtw_signer');
  await template.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await template.end();
  const db = createSignerDb({
    connectionString: `postgres://mtw_signer:${signerPassword}@${container.getHost()}:${container.getPort()}/mtw_signer_template`,
    applicationName: 'signer-test-template',
  });
  await migrateToLatest(db);
  await db.destroy();
  return {
    container,
    info: {
      host: container.getHost(),
      port: container.getPort(),
      adminUser: 'mtw_admin',
      adminPassword,
      signerPassword,
    } satisfies PgInfo,
  };
}

async function deploySystem(): Promise<{ info: ChainInfo; cleanup: () => void }> {
  const anvil = await startAnvil();
  const dir = mkdtempSync(join(tmpdir(), 'mtw-signer-chain-'));
  const tag = `signer-${randomBytes(4).toString('hex')}`;
  const jsonPath = resolve(WALLET_ROOT, `contracts/deployments/ci-${tag}.json`);
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOCAL_SEED: randomBytes(32).toString('hex'),
      LOCAL_RPC_URL: anvil.url,
      DEPLOYER_KEY_SOURCE: 'local-seed',
      DEPLOYMENT_TAG: tag,
      FORK_RPC_URL: forkUpstreamUrl(),
    };
    delete env.GOVERNANCE_SAFE_ADDRESS;
    delete env.POLICY_GUARDIANS;
    const result = spawnSync('bash', [resolve(WALLET_ROOT, 'scripts/deploy-core'), 'ci'], {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 900_000,
    });
    if (result.status !== 0) {
      const tail = `${result.stdout}\n${result.stderr}`.split('\n').slice(-25).join('\n');
      throw new Error(`deploy-core ci falló:\n${tail}`);
    }
    const deployment = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      chainId: number;
      forkBlock: number;
      contracts: Record<string, { address: string; codehash: string }>;
      policy: { admin: string; mode: string; guardians: string[] };
    };
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
    const info: ChainInfo = {
      statePath,
      system: {
        chainId: deployment.chainId,
        forkBlock: deployment.forkBlock,
        contracts: Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, v.address])),
        codehashes: Object.fromEntries(Object.entries(deployment.contracts).map(([k, v]) => [k, v.codehash])),
        policy: deployment.policy,
      },
    };
    return {
      info,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } finally {
    rmSync(jsonPath, { force: true });
    await anvil.stop();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, chain] = await Promise.all([startPostgres(), deploySystem()]);
  project.provide('pg', postgres.info);
  project.provide('chain', chain.info);
  return async () => {
    chain.cleanup();
    await postgres.container.stop();
  };
}
