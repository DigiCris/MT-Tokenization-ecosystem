// CLI de operadores (`node src/operators/cli.ts`) como proceso real en los tests de P15: misma base, misma cadena de
// auditoría y misma clave de cifrado de campos que los listeners del entorno (el email que encola lo entrega el
// pipeline del test), shards del signer por mTLS, el fork y el snapshot firmado. El código TOTP del operador va por
// stdin, como lo usa un operador; el secreto se lee del archivo 0600 que escribe el alta.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { URI } from 'otpauth';
import { localEnv } from './config.ts';
import type { OnboardingEnv } from './onboarding.ts';

const APP = resolve(import.meta.dirname, '../..');

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface TestOperator {
  id: string;
  email: string;
  /** Código TOTP del paso actual (o `steps` pasos adelante: la ventana acepta ±1 y el anti-replay exige avanzar). */
  totp: (steps?: number) => string;
  /** Próximo código que el anti-replay acepta (paso actual o el siguiente; si ya se usaron, espera al próximo). */
  next: () => Promise<string>;
}

export interface OperatorsCli {
  dir: string;
  run: (args: readonly string[], stdin?: string) => Promise<CliResult>;
  add: (label: string) => Promise<TestOperator>;
  cleanup: () => void;
}

export function operatorsCli(env: OnboardingEnv): OperatorsCli {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-operators-'));
  const config = env.wallet.config;
  const vars = localEnv({
    MTW_ENV_FILE: '/dev/null',
    LOG_LEVEL: 'silent',
    PLATFORM_ID: config.platformId,
    DATABASE_URL: env.db.appUrl,
    AUDIT_CHAIN_KEY: config.secrets.auditChainKey.reveal().toString('base64'),
    APP_FIELD_ENCRYPTION_KEY: config.secrets.fieldEncryptionKey.reveal().toString('base64'),
    RPC_PRIMARY_URL: env.anvil.url,
    RPC_SECONDARY_URL: env.anvil.url,
    RPC_TIMEOUT_MS: '30000',
    SIGNER_SHARDS: JSON.stringify([{ id: 'dev-1', url: env.executorShard.url }]),
    MTLS_CA_CERT_PATH: env.pki.ca,
    MTLS_BACKEND_CLIENT_CERT_PATH: env.pki.client.cert,
    MTLS_BACKEND_CLIENT_KEY_PATH: env.pki.client.key,
    POLICY_SNAPSHOT_PATH: env.snapshotPath,
    POLICY_SIGNING_PUBLIC_KEY: env.keys.policy.publicBase64,
    GAS_TOPUP_MIN_WEI: '200000000000000',
    GAS_TOPUP_TARGET_WEI: '1000000000000000',
    GAS_TANK_DAILY_CAP_WEI: '3000000000000000',
  });
  const run = (args: readonly string[], stdin = ''): Promise<CliResult> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ['src/operators/cli.ts', ...args], {
        cwd: APP,
        env: { PATH: process.env.PATH, ...vars },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('error', reject);
      child.once('close', (code) => {
        resolveRun({ code, stdout, stderr });
      });
      child.stdin.end(stdin);
    });
  return {
    dir,
    run,
    add: async (label) => {
      const email = `${label}-${crypto.randomUUID().slice(0, 8)}@operators.test.invalid`;
      const file = join(dir, `${label}.totp-uri`);
      const result = await run([
        'operator:add',
        '--email',
        email,
        '--name',
        `Operador ${label}`,
        '--totp-uri-file',
        file,
      ]);
      if (result.code !== 0) throw new Error(`operator:add falló: ${result.stderr}`);
      // El secreto nunca sale por la salida estándar: queda en el archivo 0600.
      if (/otpauth:\/\/|secret=/i.test(result.stdout) || (statSync(file).mode & 0o077) !== 0) {
        throw new Error('operator:add expuso el secreto TOTP');
      }
      const totp = URI.parse(readFileSync(file, 'utf8').trim());
      const { operatorId } = JSON.parse(result.stdout) as { operatorId: string };
      let last = -1;
      return {
        id: operatorId,
        email,
        totp: (steps = 0) => totp.generate({ timestamp: Date.now() + steps * 30_000 }),
        next: async () => {
          for (;;) {
            const current = Math.floor(Date.now() / 30_000);
            const step = Math.max(current, last + 1);
            if (step <= current + 1) {
              last = step;
              return totp.generate({ timestamp: step * 30_000 + 1_000 });
            }
            await sleep(1_000);
          }
        },
      };
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Salida JSON de un comando exitoso (falla el test con stderr si no lo fue). */
export function cliJson(result: CliResult): unknown {
  if (result.code !== 0) throw new Error(`la CLI terminó con ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}
