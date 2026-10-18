// P11.T09 + P12.T06–T07 con el entrypoint real: `node src/main.ts gas-tank` como proceso contra PostgreSQL, Valkey,
// el fork con el sistema desplegado y el shard `platform` real. Una wallet onboardeada por la API pide el deploy; el
// dispatcher del outbox publica WALLET_DEPLOY_REQUESTED en la cola `gas-tank` y el proceso la consume: createWallet por
// la cuenta gas tank, verificación V9 §16 y ACTIVE. Expone sus métricas, cierra con SIGTERM y no imprime secretos.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testRedisUrl } from '../helpers/api.ts';
import { localEnv } from '../helpers/config.ts';
import { freePort } from '../helpers/fork.ts';
import {
  critical,
  idempotencyKey,
  onboard,
  startOnboardingEnv,
  until,
  type OnboardingEnv,
} from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

const APP = resolve(import.meta.dirname, '../..');
let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.gasTankEntrypoint });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

function startGasTank(vars: Record<string, string | undefined>): {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<number | null>;
} {
  const child = spawn(process.execPath, ['src/main.ts', 'gas-tank'], {
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
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      return Promise.race([exited, sleep(20_000).then(() => -1)]);
    },
  };
}

describe('entrypoint gas-tank', () => {
  it('consume el deploy de la cola, deja la wallet ACTIVE, expone métricas y cierra con SIGTERM', async () => {
    const o = await onboard(env);
    const requested = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/deploy`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(requested.statusCode, requested.body).toBe(202);

    const metricsPort = await freePort();
    const config = env.wallet.config;
    const vars = localEnv({
      LOG_LEVEL: 'info',
      MTW_ENV_FILE: '/dev/null',
      PLATFORM_ID: config.platformId,
      DATABASE_URL: env.db.appUrl,
      REDIS_URL: testRedisUrl(REDIS_DBS.gasTankEntrypoint),
      RPC_PRIMARY_URL: env.anvil.url,
      RPC_SECONDARY_URL: env.anvil.url,
      RPC_TIMEOUT_MS: '30000',
      // Misma clave de la cadena de auditoría que la API: el proceso agrega eventos a la misma cadena.
      AUDIT_CHAIN_KEY: config.secrets.auditChainKey.reveal().toString('base64'),
      SIGNER_SHARDS: JSON.stringify([{ id: 'dev-1', url: env.executorShard.url }]),
      SIGNER_PLATFORM_URL: env.platformShard.url,
      MTLS_CA_CERT_PATH: env.pki.ca,
      MTLS_BACKEND_CLIENT_CERT_PATH: env.pki.client.cert,
      MTLS_BACKEND_CLIENT_KEY_PATH: env.pki.client.key,
      POLICY_SNAPSHOT_PATH: env.snapshotPath,
      POLICY_SIGNING_PUBLIC_KEY: env.keys.policy.publicBase64,
      GAS_TOPUP_MIN_WEI: '200000000000000',
      GAS_TOPUP_TARGET_WEI: '1000000000000000',
      GAS_TANK_DAILY_CAP_WEI: '3000000000000000',
      GAS_TANK_INTERVAL_MS: '60000',
      GAS_TANK_METRICS_PORT: String(metricsPort),
      METRICS_BIND_HOST: '127.0.0.1',
    });
    const gasTank = startGasTank(vars);
    try {
      await until(async () => {
        const row = await env.db.app
          .selectFrom('wallets')
          .select('status')
          .where('id', '=', o.walletId)
          .executeTakeFirstOrThrow();
        if (row.status === 'FAILED') throw new Error(`la wallet quedó FAILED:\n${gasTank.output()}`);
        return row.status === 'ACTIVE' ? true : undefined;
      }, 240_000);
      const metrics = await until(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
          return response.ok ? await response.text() : undefined;
        } catch {
          return undefined;
        }
      }, 30_000);
      expect(metrics).toContain('mtw_gas_tank_balance_wei');
      expect(metrics).toContain('mtw_wallet_onboarding_total{step="verify",result="active"} 1');
      expect(metrics).toContain('mtw_gas_tank_transactions_total{purpose="DEPLOY",result="MINED"} 1');
      // El evento queda procesado cuando el handler termina (después del fondeo inicial de S).
      await until(async () => {
        const event = await env.db.app
          .selectFrom('outbox_events')
          .select('processed_at')
          .where('aggregate_id', '=', o.walletId)
          .where('event_type', '=', 'WALLET_DEPLOY_REQUESTED')
          .executeTakeFirstOrThrow();
        return event.processed_at === null ? undefined : true;
      }, 60_000);
    } finally {
      expect(await gasTank.stop()).toBe(0);
    }
    const output = gasTank.output();
    expect(output).toContain('gas tank iniciado');
    for (const secret of [vars.AUDIT_CHAIN_KEY, vars.OPAQUE_SERVER_SETUP, new URL(env.db.appUrl).password]) {
      expect(output).not.toContain(secret);
    }
    // Onboarding por la API, arranque del proceso real, deploy por la cuenta gas tank y verificación: las esperas de
    // arriba suman hasta ~330 s; el timeout por defecto (60 s) cortaba antes que ellas en un runner cargado.
  }, 420_000);
});
