// Arnés de integración: un shard real del signer (misma configuración, runtime, provider de desarrollo con sus
// guardas, snapshot firmado y servidor mTLS) contra un Anvil propio con el sistema desplegado y una DB propia.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { loadConfig, type SignerConfig } from '../../src/config/env.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { startSigner, type SignerRuntime } from '../../src/runtime.ts';
import { startAnvil, type AnvilInstance, freePort } from './anvil.ts';
import { TestChain } from './chain.ts';
import { createTestDatabase, type TestDatabase } from './db.ts';
import { mtlsClient } from './https.ts';
import { testEdKey, type TestEdKey } from './keys.ts';
import { captureLogger, type CapturedLogger } from './logs.ts';
import { createTestPki, type TestPki } from './mtls.ts';
import { testSnapshot, writeSignedSnapshot } from './policy.ts';
import { shardWorkspace, type ShardWorkspace } from './shard.ts';

export interface SignerKeys {
  issuer: TestEdKey;
  attestation: TestEdKey;
  policy: TestEdKey;
  monitor: TestEdKey;
}

export interface SignerHarness {
  runtime: SignerRuntime;
  config: SignerConfig;
  url: string;
  client: ReturnType<typeof mtlsClient>;
  keys: SignerKeys;
  pki: TestPki;
  anvil: AnvilInstance;
  chain: TestChain;
  db: TestDatabase;
  ws: ShardWorkspace;
  logs: CapturedLogger;
  contracts: Record<string, Address>;
  /** Reinicia el shard con otra configuración (mismos keystores, DB y Anvil). */
  restart: (overrides?: Record<string, string>) => Promise<void>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  shardId?: string;
  env?: Record<string, string>;
  snapshotVersion?: number;
  /** Comparte Anvil, DB, claves y PKI con otro arnés (dos shards en la misma prueba). */
  share?: Pick<SignerHarness, 'anvil' | 'chain' | 'keys' | 'pki'>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<SignerHarness> {
  const shardId = options.shardId ?? 'dev-1';
  const anvil = options.share?.anvil ?? (await startAnvil({ loadState: inject('chain').statePath }));
  const chain = options.share?.chain ?? (await new TestChain(anvil).init());
  const pki = options.share?.pki ?? createTestPki();
  const keys = options.share?.keys ?? {
    issuer: testEdKey(),
    attestation: testEdKey(),
    policy: testEdKey(),
    monitor: testEdKey(),
  };
  const db = await createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), 'mtw-signer-h-'));
  const ws = shardWorkspace(shardId, root);
  const policyPath = writeSignedSnapshot(root, testSnapshot(options.snapshotVersion ?? 1), keys.policy);
  const port = await freePort();
  const logs = captureLogger('debug');
  const baseEnv: Record<string, string> = {
    APP_ENV: 'local',
    SIGNER_PROVIDER: 'development',
    SIGNER_SHARD_ID: shardId,
    SIGNER_HOST: '127.0.0.1',
    SIGNER_PORT: String(port),
    SIGNER_KEYSTORE_DIR: ws.keystoreDir,
    SIGNER_UNLOCK_CREDENTIAL_FILE: ws.credentialFile,
    SIGNER_DATABASE_URL: db.url,
    SIGNER_ATTESTATION_PRIVATE_KEY: keys.attestation.privateBase64,
    SIGNER_RPC_PRIMARY_URL: anvil.url,
    SIGNER_RPC_SECONDARY_URL: anvil.url,
    SIGNER_RPC_QUORUM_MODE: 'local-single',
    // Anvil trae el estado del fork bajo demanda desde un RPC remoto con límite de ritmo (en CI, varios forks a la
    // vez): una lectura en frío puede tardar más que el timeout por defecto (5 s) de un nodo real.
    RPC_TIMEOUT_MS: '30000',
    MTLS_CA_CERT_PATH: pki.caPath,
    MTLS_SIGNER_SERVER_CERT_PATH: pki.server.certPath,
    MTLS_SIGNER_SERVER_KEY_PATH: pki.server.keyPath,
    POLICY_SNAPSHOT_PATH: policyPath,
    POLICY_SIGNING_PUBLIC_KEY: keys.policy.publicBase64,
    SESSION_ISSUER_PUBLIC_KEY: keys.issuer.publicBase64,
    INTEGRITY_REQUIRED: 'false',
    INTEGRITY_MONITOR_PUBLIC_KEY: keys.monitor.publicBase64,
    LOG_LEVEL: 'debug',
  };
  let env = { ...baseEnv, ...options.env };
  let config = loadConfig({ env, envFile: null });
  let runtime = await startSigner(config, { logger: logs.logger, migrate: true, developmentRoots: [ws.root] });
  const url = `https://127.0.0.1:${port}`;
  const harness: SignerHarness = {
    runtime,
    config,
    url,
    client: mtlsClient(url, { ca: pki.ca, cert: pki.client.cert, key: pki.client.key }),
    keys,
    pki,
    anvil,
    chain,
    db,
    ws,
    logs,
    contracts: runtime.snapshot.snapshot.contracts,
    restart: async (overrides = {}) => {
      await runtime.close();
      env = { ...env, ...overrides };
      config = loadConfig({ env, envFile: null });
      runtime = await startSigner(config, { logger: logs.logger, developmentRoots: [ws.root] });
      harness.runtime = runtime;
      harness.config = config;
    },
    close: async () => {
      await runtime.close();
      await db.close();
      if (options.share === undefined) {
        await anvil.stop();
        pki.cleanup();
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}
