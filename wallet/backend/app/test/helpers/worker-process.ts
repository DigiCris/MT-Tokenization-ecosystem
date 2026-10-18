// Proceso `worker` real (src/main.ts worker) contra el entorno de operaciones de un test: misma base, misma Valkey,
// mismo fork y mismo shard del signer (o los proxies de fallas que el test ponga delante), con las mismas claves que
// los listeners del test (cadena de auditoría, emisor de sesiones, cifrado de campos). Sirve para matarlo con kill -9
// en cualquier punto del pipeline y reiniciarlo.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inject } from 'vitest';
import { testRedisUrl } from './api.ts';
import { localEnv } from './config.ts';
import { freePort } from './fork.ts';
import type { OperationsEnv } from './operations.ts';

const APP = resolve(import.meta.dirname, '../..');

export interface WorkerProcess {
  child: ChildProcess;
  output: () => string;
  /** SIGKILL (kill -9) o SIGTERM; devuelve el código de salida (null si lo mató una señal). */
  kill: (signal?: 'SIGKILL' | 'SIGTERM') => Promise<number | null>;
}

export async function workerProcessEnv(
  env: OperationsEnv,
  options: { rpcUrl?: string; signerUrl?: string; overrides?: Record<string, string> } = {},
): Promise<Record<string, string | undefined>> {
  const config = env.base.wallet.config;
  const mailpit = inject('mailpit');
  return localEnv({
    LOG_LEVEL: 'debug',
    MTW_ENV_FILE: '/dev/null',
    PLATFORM_ID: config.platformId,
    DATABASE_URL: env.base.db.appUrl,
    REDIS_URL: testRedisUrl(env.redisDb),
    RPC_PRIMARY_URL: options.rpcUrl ?? env.base.anvil.url,
    RPC_SECONDARY_URL: options.rpcUrl ?? env.base.anvil.url,
    RPC_TIMEOUT_MS: '30000',
    AUDIT_CHAIN_KEY: config.secrets.auditChainKey.reveal().toString('base64'),
    APP_FIELD_ENCRYPTION_KEY: config.secrets.fieldEncryptionKey.reveal().toString('base64'),
    SESSION_ISSUER_PRIVATE_KEY: env.base.keys.issuer.privateBase64,
    SESSION_ISSUER_PUBLIC_KEY: env.base.keys.issuer.publicBase64,
    SMTP_HOST: mailpit.smtpHost,
    SMTP_PORT: String(mailpit.smtpPort),
    SIGNER_SHARDS: JSON.stringify([{ id: 'dev-1', url: options.signerUrl ?? env.base.executorShard.url }]),
    MTLS_CA_CERT_PATH: env.base.pki.ca,
    MTLS_BACKEND_CLIENT_CERT_PATH: env.base.pki.client.cert,
    MTLS_BACKEND_CLIENT_KEY_PATH: env.base.pki.client.key,
    POLICY_SNAPSHOT_PATH: env.base.snapshotPath,
    POLICY_SIGNING_PUBLIC_KEY: env.base.keys.policy.publicBase64,
    GAS_TOPUP_MIN_WEI: '200000000000000',
    GAS_TOPUP_TARGET_WEI: '1000000000000000',
    GAS_TANK_DAILY_CAP_WEI: '3000000000000000',
    CONFIRMATION_POLICY: 'depth',
    CONFIRMATION_DEPTH: '2',
    FINALIZATION_DEPTH: '4',
    OUTBOX_POLL_INTERVAL_MS: '100',
    WORKER_LEASE_TTL_MS: '3000',
    WORKER_RECEIPT_TIMEOUT_MS: '600000',
    WORKER_RETRY_BASE_MS: '100',
    WORKER_RETRY_MAX_MS: '1000',
    WATCHER_INTERVAL_MS: '500',
    INDEXER_INTERVAL_MS: '1000',
    RECONCILER_INTERVAL_MS: '60000',
    WORKER_METRICS_PORT: String(await freePort()),
    METRICS_BIND_HOST: '127.0.0.1',
    ...options.overrides,
  });
}

export function startWorkerProcess(vars: Record<string, string | undefined>): WorkerProcess {
  const child = spawn(process.execPath, ['src/main.ts', 'worker'], {
    cwd: APP,
    env: { PATH: process.env.PATH, ...vars },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => {
      resolveExit(code);
    });
  });
  return {
    child,
    output: () => output,
    kill: async (signal = 'SIGKILL') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return Promise.race([exited, sleep(20_000).then(() => -1)]);
    },
  };
}
