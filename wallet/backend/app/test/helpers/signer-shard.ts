// Shards reales del signer (wallet/backend/signer, proyecto independiente) para los tests de integración del backend:
// cada uno es un proceso `node src/main.ts serve` con el provider `selfhosted` (inicializado con su `shard:create`),
// su DB propia (rol mtw_signer), sus keystores y su credencial en directorios separados, su snapshot de policy firmado
// y su certificado de servidor mTLS. El backend habla con ellos sólo por mTLS.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { inject } from 'vitest';
import { SignerClient, type SignerTls } from '../../src/signer-client/client.ts';
import { freePort } from './fork.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');
const SIGNER_ROOT = resolve(WALLET_ROOT, 'backend/signer');

export interface EdKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateBase64: string;
  publicBase64: string;
}

export function edKey(): EdKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    privateBase64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export interface Pki {
  dir: string;
  ca: string;
  server: { cert: string; key: string };
  client: { cert: string; key: string };
  /** Certificado de cliente firmado por otra CA (debe rechazarse). */
  foreignClient: { cert: string; key: string };
  tls: () => SignerTls;
  cleanup: () => void;
}

function openssl(args: string[]): void {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} falló: ${r.stderr.split('\n')[0]}`);
}

export function createPki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-backend-pki-'));
  const ca = (name: string) => {
    const key = join(dir, `${name}-key.pem`);
    const cert = join(dir, `${name}.pem`);
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    openssl([
      'req',
      '-x509',
      '-new',
      '-key',
      key,
      '-sha256',
      '-days',
      '2',
      '-subj',
      `/CN=${name}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-out',
      cert,
    ]);
    return { key, cert };
  };
  const leaf = (issuer: { key: string; cert: string }, name: string, cn: string, ext: string) => {
    const key = join(dir, `${name}-key.pem`);
    const cert = join(dir, `${name}.pem`);
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    openssl(['req', '-new', '-key', key, '-subj', `/CN=${cn}`, '-out', `${cert}.csr`]);
    writeFileSync(`${cert}.ext`, ext);
    openssl([
      'x509',
      '-req',
      '-in',
      `${cert}.csr`,
      '-CA',
      issuer.cert,
      '-CAkey',
      issuer.key,
      '-CAcreateserial',
      '-days',
      '2',
      '-sha256',
      '-extfile',
      `${cert}.ext`,
      '-out',
      cert,
    ]);
    return { key, cert };
  };
  const main = ca('ca');
  const foreign = ca('foreign');
  const clientExt =
    'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n';
  const pki: Pki = {
    dir,
    ca: main.cert,
    server: leaf(
      main,
      'server',
      'mtw-signer-test',
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n',
    ),
    client: leaf(main, 'client', 'mtw-backend', clientExt),
    foreignClient: leaf(foreign, 'foreign-client', 'mtw-backend', clientExt),
    tls: () => ({
      ca: readFileSync(main.cert),
      cert: readFileSync(pki.client.cert),
      key: readFileSync(pki.client.key),
    }),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return pki;
}

/** Snapshot de policy local firmado (mismo formato que config/policy/<env>/policy-snapshot.json). */
export function writePolicySnapshot(
  dir: string,
  key: EdKeyPair,
  contracts: Record<string, string>,
  version = 1,
): string {
  const chain = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    contracts: Record<string, { address: string }>;
  };
  const snapshot = {
    format: 'mtw-policy-snapshot',
    formatVersion: 1,
    version,
    environment: 'local',
    platformId: 'mtw',
    chainId: 8453,
    issuedAt: new Date().toISOString(),
    contracts: {
      securityGuard: contracts.SecurityGuard,
      rotationTimelock: contracts.RotationTimelock,
      walletFactory: contracts.WalletFactory,
      safeBootstrap: contracts.SafeBootstrap,
      policyRegistry: contracts.PolicyRegistry,
      destinationWhitelist: contracts.DestinationWhitelist,
      denyAllModuleGuard: contracts.DenyAllModuleGuard,
      swapExecutor: contracts.SwapExecutorV3,
      safeL2Singleton: chain.contracts.safeL2Singleton?.address,
      safeProxyFactory: chain.contracts.safeProxyFactory?.address,
    },
    tokens: [
      { symbol: 'USDC', address: chain.contracts.usdc?.address, decimals: 6 },
      { symbol: 'USDT', address: chain.contracts.usdt?.address, decimals: 6 },
    ],
    operations: {
      U: [
        'SEND',
        'SWAP_APPROVE',
        'SWAP',
        'APPROVE_REVOKE',
        'WHITELIST_ADD',
        'WHITELIST_REMOVE',
        'ROTATION_PROPOSE',
        'ROTATION_EXECUTE',
        'NOOP_CANCEL',
        'MIGRATION_TRANSFER',
        'GUARD_UPGRADE',
      ],
      R: [
        'NOOP_CANCEL',
        'APPROVE_REVOKE',
        'WHITELIST_REMOVE',
        'ROTATION_PROPOSE',
        'ROTATION_EXECUTE',
        'MIGRATION_TRANSFER',
      ],
    },
    limits: {
      perOperationMax: '10000000000',
      dailyOutflowMax: '20000000000',
      twoFactorThreshold: '1000000000',
      swapMax: '10000000000',
      minPerOperation: '1000000',
    },
    swap: { defaultSlippageBps: 30, maxSlippageBps: 50, deadlineSeconds: 600 },
    session: { maxSignatureAgeSeconds: 86400, clockSkewSeconds: 60 },
    gas: { maxFeePerGasWei: '10000000000', maxPriorityFeePerGasWei: '2000000000', maxGasLimit: 1500000 },
    gasTank: { topupMaxWei: '1000000000000000', dailyCapWei: '3000000000000000', maxGasLimit: 3000000 },
  };
  const path = join(dir, 'policy-snapshot.json');
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sig`, sign(null, bytes, key.privateKey).toString('base64'));
  return path;
}

export interface SignerShard {
  shardId: string;
  url: string;
  client: SignerClient;
  /** Salida JSON de `shard:create` (fingerprint y, en `platform`, la dirección del gas tank). */
  created: { credentialFingerprint: string; gasTank?: string };
  stop: () => Promise<void>;
  logs: () => string;
}

export interface ShardOptions {
  shardId: string;
  anvilUrl: string;
  pki: Pki;
  keys: { attestation: EdKeyPair; policy: EdKeyPair; issuer: EdKeyPair };
  snapshotPath: string;
}

async function createShardDatabase(): Promise<string> {
  const info = inject('pg');
  const name = `signer_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: info.adminPassword,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER mtw_signer`);
  await admin.end();
  const db = new pg.Client({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: info.adminPassword,
    database: name,
  });
  await db.connect();
  await db.query('ALTER SCHEMA public OWNER TO mtw_signer');
  await db.end();
  return `postgres://mtw_signer:${info.signerPassword}@${info.host}:${info.port}/${name}`;
}

export async function startSignerShard(options: ShardOptions): Promise<SignerShard> {
  const root = mkdtempSync(join(tmpdir(), `mtw-shard-${options.shardId}-`));
  const keystoreDir = join(root, 'volume', 'keystore');
  const secrets = join(root, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    APP_ENV: 'local',
    MTW_ENV_FILE: join(root, 'sin-env'),
    SIGNER_PROVIDER: 'selfhosted',
    SIGNER_SHARD_ID: options.shardId,
    SIGNER_HOST: '127.0.0.1',
    SIGNER_PORT: String(port),
    SIGNER_KEYSTORE_DIR: keystoreDir,
    SIGNER_UNLOCK_CREDENTIAL_FILE: join(secrets, 'unlock.key'),
    SIGNER_DATABASE_URL: await createShardDatabase(),
    SIGNER_ATTESTATION_PRIVATE_KEY: options.keys.attestation.privateBase64,
    SIGNER_RPC_PRIMARY_URL: options.anvilUrl,
    SIGNER_RPC_SECONDARY_URL: options.anvilUrl,
    SIGNER_RPC_QUORUM_MODE: 'local-single',
    MTLS_CA_CERT_PATH: options.pki.ca,
    MTLS_SIGNER_SERVER_CERT_PATH: options.pki.server.cert,
    MTLS_SIGNER_SERVER_KEY_PATH: options.pki.server.key,
    POLICY_SNAPSHOT_PATH: options.snapshotPath,
    POLICY_SIGNING_PUBLIC_KEY: options.keys.policy.publicBase64,
    SESSION_ISSUER_PUBLIC_KEY: options.keys.issuer.publicBase64,
    INTEGRITY_REQUIRED: 'false',
    LOG_LEVEL: 'info',
  };
  const create = spawnSync('node', [join(SIGNER_ROOT, 'scripts/create-shard.ts'), '--generate-credential'], {
    cwd: SIGNER_ROOT,
    env,
    encoding: 'utf8',
  });
  if (create.status !== 0) throw new Error(`shard:create ${options.shardId} falló: ${create.stderr}`);
  const created = JSON.parse(create.stdout.trim().split('\n').at(-1) ?? '{}') as SignerShard['created'];
  let output = '';
  const child: ChildProcess = spawn('node', [join(SIGNER_ROOT, 'src/main.ts'), 'serve'], {
    cwd: SIGNER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  const exited = new Promise<void>((r) =>
    child.once('exit', () => {
      r();
    }),
  );
  const url = `https://127.0.0.1:${port}`;
  const client = new SignerClient({ shardId: options.shardId, url, tls: options.pki.tls(), timeoutMs: 60_000 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`el shard ${options.shardId} terminó al arrancar: ${output.slice(-500)}`);
    try {
      const health = await client.health();
      if (health.ready) break;
    } catch {
      // todavía arrancando
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`el shard ${options.shardId} no quedó listo: ${output.slice(-500)}`);
    }
    await sleep(250);
  }
  return {
    shardId: options.shardId,
    url,
    client,
    created,
    logs: () => output,
    stop: async () => {
      client.close();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
