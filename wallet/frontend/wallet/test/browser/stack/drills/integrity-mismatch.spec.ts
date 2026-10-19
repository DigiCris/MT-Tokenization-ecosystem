// P20.MAN — simulacro de mismatch de integridad con el stack completo (MTW_DRILL=integrity: signer y worker con
// INTEGRITY_REQUIRED y el monitor en MTW_DRILL_MONITOR_PORT). El spec compila y sirve Recovery con `vite preview`,
// firma los manifests de las dos apps con claves de release efímeras y levanta el integrity monitor real contra los dos
// origins. Con las atestaciones OK la cooperación de S funciona (alta en la whitelist y un envío); al alterar un archivo
// servido de Recovery el monitor pausa en ≤ 2 ciclos, el signer rechaza la co-firma (COOPERATION_PAUSED, la operación
// queda en reintento), GET /platform/status informa PAUSED y Wallet muestra el aviso; al restaurar el archivo la pausa
// sigue hasta que dos operadores aprueban ese release, y entonces la operación retenida se ejecuta sola.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { iSafeAbi } from '../../../../src/chain/abis/ISafe.ts';
import { verifyPrepared } from '../../../../src/chain/safe-tx.ts';
import { signAndSubmit, waitForOperation } from '../../../../src/operations/sign.ts';
import { transferCall } from '../../../../src/send/send.ts';
import { chain, fund, USDC, USDC_HOLDER } from '../helpers/chain.ts';
import { activeWallet } from '../helpers/onboard.ts';
import { activeDestination, unlockInNode } from '../helpers/operate.ts';
import { stack } from '../helpers/stack.ts';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');
const RECOVERY = resolve(APP_ROOT, '../recovery');
const MONITOR = resolve(APP_ROOT, '../../backend/integrity-monitor');
// 4192 y no 4190: el 4190 está en la lista de "bad ports" de Fetch y el fetch de Node (undici) lo rechaza.
const MONITOR_URL = `http://127.0.0.1:${process.env.MTW_DRILL_MONITOR_PORT ?? '4192'}`;
const RECOVERY_PORT = 5174;
const children: ChildProcess[] = [];

function envValue(name: string): string {
  const line = readFileSync(stack().envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim() ?? '';
  if (value === '') throw new Error(`falta ${name} en el .env del stack`);
  return value;
}

function ok(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr.slice(-800)}`);
}

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  diagnose?: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`no se cumplió a tiempo: ${what}${diagnose === undefined ? '' : `\n${await diagnose()}`}`);
    await sleep(1_000);
  }
}

/** Sin secretos: el estado público de la plataforma y las líneas de integridad del log del worker del stack. */
async function cooperationDiagnostics(): Promise<string> {
  const status = await fetch(`${stack().urls.apiWallet}/api/v1/platform/status`)
    .then((r) => r.text())
    .catch((error: unknown) => String(error));
  let worker: string;
  try {
    worker = readFileSync(join(stack().dir, 'logs', 'worker.log'), 'utf8')
      .split('\n')
      .filter((line) => /integri|cooperaci/i.test(line))
      .slice(-15)
      .join('\n')
      .replace(/[a-z][\w+.-]*:\/\/[^\s"@]*@[^\s"]*/gi, '<url con credenciales>');
  } catch (error) {
    worker = String(error);
  }
  return `platform/status: ${status}\nworker (integridad):\n${worker}`;
}

interface AppStatus {
  app: string;
  status: string;
  paused: boolean;
  lastCheckStatus: string | null;
  lastCheckProblems?: string[];
  releaseId: string | null;
}
const monitorStatus = async (app: 'WALLET' | 'RECOVERY'): Promise<AppStatus> => {
  const body = (await (await fetch(`${MONITOR_URL}/v1/status`)).json()) as { apps: AppStatus[] };
  const found = body.apps.find((a) => a.app === app);
  if (found === undefined) throw new Error(`sin estado de ${app}`);
  return found;
};
const platformStatus = async (): Promise<string> => {
  const body = (await (await fetch(`${stack().urls.apiWallet}/api/v1/platform/status`)).json()) as {
    cooperation: string;
  };
  return body.cooperation;
};

function releaseKey(dir: string, name: string): { file: string; publicDer: string } {
  const pair = generateKeyPairSync('ed25519');
  const file = join(dir, `${name}.pem`);
  writeFileSync(file, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return { file, publicDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

test.afterAll(() => {
  for (const child of children) child.kill('SIGTERM');
});

test('mismatch de Recovery: pausa en ≤ 2 ciclos, operación retenida, doble aprobación y reanudación', async ({
  page,
}) => {
  test.setTimeout(1_500_000);
  const state = stack();
  const work = mkdtempSync(join(tmpdir(), 'mtw-integrity-drill-'));

  // 1. Recovery compilada contra este stack y servida; manifests de las dos apps firmados con claves efímeras.
  ok('pnpm', ['install', '--frozen-lockfile'], RECOVERY);
  ok('node', ['scripts/sync-design-tokens.mjs'], RECOVERY);
  ok('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], RECOVERY, {
    ...process.env,
    MTW_ENV: 'ci',
    PLATFORM_ID: state.platformId,
    RECOVERY_API_BASE_URL: state.urls.apiRecovery,
    RECOVERY_FRONTEND_RPC_URL: state.urls.anvil,
    WALLET_ORIGIN: 'http://localhost:4174',
    GOOGLE_CLIENT_ID_RECOVERY: 'mtw-browser-tests.apps.googleusercontent.com',
    GOOGLE_OAUTH_REDIRECT_URI_RECOVERY: `http://localhost:${String(RECOVERY_PORT)}/oauth/google/callback`,
    SIGNER_ATTESTATION_PUBLIC_KEY: state.signerAttestationPublicKey,
    MTW_DEPLOYMENT_FILE: state.deploymentFile,
  });
  const walletKey = releaseKey(work, 'release-wallet');
  const recoveryKey = releaseKey(work, 'release-recovery');
  ok('node', ['build/sign-manifest.ts', '--allow-dirty'], APP_ROOT, {
    ...process.env,
    MTW_RELEASE_KEY_FILE: walletKey.file,
  });
  ok('node', ['build/sign-manifest.ts', '--allow-dirty'], RECOVERY, {
    ...process.env,
    MTW_RELEASE_KEY_FILE: recoveryKey.file,
  });
  children.push(
    spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(RECOVERY_PORT), '--strictPort'], {
      cwd: RECOVERY,
      stdio: 'ignore',
    }),
  );
  await until(
    'vista previa de Recovery',
    async () => ((await fetch(`http://localhost:${String(RECOVERY_PORT)}/`)).ok ? true : undefined),
    60_000,
  );

  // 2. El integrity monitor real, con la clave de atestación del stack (la que fijan su signer y su backend).
  ok('pnpm', ['install', '--frozen-lockfile'], MONITOR);
  const ana = releaseKey(work, 'operator-ana');
  const beto = releaseKey(work, 'operator-beto');
  // El log del monitor (JSON de pino, sin secretos) queda como evidencia y explica cualquier falla del simulacro.
  const monitorLog = join(process.env.MTW_REVIEW_DIR ?? work, 'integrity-drill', 'integrity-monitor.log');
  mkdirSync(join(monitorLog, '..'), { recursive: true });
  const monitorOut = openSync(monitorLog, 'a', 0o600);
  const monitor = spawn('node', ['src/main.ts', 'serve'], {
    cwd: MONITOR,
    stdio: ['ignore', monitorOut, monitorOut],
    env: {
      PATH: process.env.PATH,
      APP_ENV: 'local',
      PLATFORM_ID: state.platformId,
      MONITOR_TARGETS: `WALLET=http://localhost:4174,RECOVERY=http://localhost:${String(RECOVERY_PORT)}`,
      MONITOR_MANIFEST_ENVIRONMENT: 'ci',
      WALLET_RELEASE_PUBLIC_KEY: walletKey.publicDer,
      RECOVERY_RELEASE_PUBLIC_KEY: recoveryKey.publicDer,
      MONITOR_ATTESTATION_PRIVATE_KEY: envValue('INTEGRITY_MONITOR_PRIVATE_KEY'),
      MONITOR_OPERATOR_KEYS: JSON.stringify({ ana: ana.publicDer, beto: beto.publicDer }),
      MONITOR_STATE_FILE: join(work, 'monitor-state.json'),
      MONITOR_INTERVAL_SECONDS: '5',
      MONITOR_PORT: new URL(MONITOR_URL).port,
    },
  });
  children.push(monitor);
  const monitorTail = (): string =>
    `monitor (exit ${String(monitor.exitCode)}):\n${readFileSync(monitorLog, 'utf8').slice(-4_000)}`;
  for (const app of ['WALLET', 'RECOVERY'] as const) {
    let last: AppStatus | undefined;
    const deadline = Date.now() + 120_000;
    while (last?.status !== 'OK') {
      last = await monitorStatus(app).catch(() => undefined);
      if (Date.now() > deadline)
        throw new Error(`${app} no quedó OK en el monitor: ${JSON.stringify(last)}\n${monitorTail()}`);
      await sleep(1_000);
    }
  }
  await until(
    'cooperación ACTIVE',
    async () => ((await platformStatus()) === 'ACTIVE' ? true : undefined),
    90_000,
    cooperationDiagnostics,
  );

  // 3. Con la cooperación activa: Safe operativa, alta en la whitelist (co-firma de S) y un envío.
  const wallet = await activeWallet('integrity-drill');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 10_000_000n);
  const destination = await activeDestination(wallet, 'Destino del simulacro');
  const send = async (amount: bigint): Promise<string> => {
    const unlocked = await unlockInNode(wallet);
    const operation = await wallet.api.prepareSend(unlocked.platform, wallet.wallet.id, {
      token: 'USDC',
      destination,
      amount: amount.toString(),
    });
    const nonce = await chain().readContract({ address: wallet.wallet.safe, abi: iSafeAbi, functionName: 'nonce' });
    await signAndSubmit(
      wallet.api,
      unlocked,
      verifyPrepared(operation, {
        safe: wallet.wallet.safe,
        chainId: 8453,
        onchainNonce: nonce,
        build: (n) => transferCall({ address: USDC }, destination, amount, n),
      }),
    );
    return operation.operationId;
  };
  const first = await send(1_000_000n);
  expect((await waitForOperation(wallet.api, first, { timeoutMs: 240_000 })).status).toMatch(
    /MINED|CONFIRMED|FINALIZED/,
  );

  // 4. Un archivo servido de Recovery alterado: pausa en ≤ 2 ciclos del monitor (5 s cada uno).
  const asset = readdirSync(join(RECOVERY, 'dist/assets')).find((f) => f.endsWith('.js'));
  if (asset === undefined) throw new Error('sin assets de Recovery');
  const assetPath = join(RECOVERY, 'dist/assets', asset);
  const original = readFileSync(assetPath);
  const tamperedAt = Date.now();
  appendFileSync(assetPath, '\n// alterado por el simulacro de P20.MAN\n');
  await until('RECOVERY pausada', async () => ((await monitorStatus('RECOVERY')).paused ? true : undefined), 30_000);
  const pauseMs = Date.now() - tamperedAt;
  expect(pauseMs).toBeLessThanOrEqual(2 * 5_000 + 5_000);

  // 5. La co-firma queda retenida (COOPERATION_PAUSED) y la plataforma informa la pausa; Wallet muestra el aviso.
  const held = await send(1_000_000n);
  const retained = await until(
    'operación retenida por la pausa',
    async () => {
      const op = await wallet.api.operation(held);
      return op.lastErrorCode === 'COOPERATION_PAUSED' ? op : undefined;
    },
    120_000,
  );
  expect(retained.txHash).toBeNull();
  await until(
    'cooperación PAUSED',
    async () => ((await platformStatus()) === 'PAUSED' ? true : undefined),
    90_000,
    cooperationDiagnostics,
  );
  await page.goto('/login');
  await expect(page.getByRole('alert').filter({ hasText: 'La plataforma pausó la co-firma' })).toBeVisible({
    timeout: 90_000,
  });
  const evidence =
    process.env.MTW_REVIEW_DIR === undefined ? null : join(process.env.MTW_REVIEW_DIR, 'integrity-drill');
  if (evidence !== null) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'aviso-de-pausa.png'), fullPage: true });
  }

  // 6. Restaurado el archivo, el chequeo vuelve a OK pero la pausa sigue hasta la doble aprobación.
  writeFileSync(assetPath, original);
  const restored = await until(
    'chequeo OK con la pausa vigente',
    async () => {
      const s = await monitorStatus('RECOVERY');
      return s.lastCheckStatus === 'OK' && s.paused ? s : undefined;
    },
    30_000,
  );
  expect((await wallet.api.operation(held)).txHash).toBeNull();
  const attestations = (await (await fetch(`${MONITOR_URL}/v1/attestations`)).json()) as {
    attestations: Record<string, string>;
  };
  const payload = JSON.parse(
    Buffer.from(attestations.attestations.RECOVERY?.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { manifestSha256: string };
  const approve = (operator: string, keyFile: string) => {
    ok(
      'node',
      [
        'scripts/approve-resume.ts',
        ...['--operator', operator, '--key-file', keyFile, '--app', 'RECOVERY'],
        ...['--release', restored.releaseId ?? '', '--manifest-sha256', payload.manifestSha256],
        ...['--platform', state.platformId, '--environment', 'local', '--monitor', MONITOR_URL],
      ],
      MONITOR,
    );
  };
  approve('ana', ana.file);
  expect((await monitorStatus('RECOVERY')).paused).toBe(true);
  approve('beto', beto.file);
  expect(await monitorStatus('RECOVERY')).toMatchObject({ paused: false, status: 'OK' });

  // 7. La operación retenida se ejecuta sola (reintento del worker) y la cooperación vuelve a ACTIVE.
  const resumed = await waitForOperation(wallet.api, held, { timeoutMs: 900_000, intervalMs: 5_000 });
  expect(resumed.status).toMatch(/MINED|CONFIRMED|FINALIZED/);
  await until(
    'cooperación ACTIVE otra vez',
    async () => ((await platformStatus()) === 'ACTIVE' ? true : undefined),
    90_000,
    cooperationDiagnostics,
  );
  if (evidence !== null) {
    const report = {
      monitorIntervalSeconds: 5,
      tamperedAsset: `assets/${asset}`,
      pauseAfterTamperMs: pauseMs,
      heldOperation: {
        id: held,
        lastErrorCode: retained.lastErrorCode,
        finalStatus: resumed.status,
        txHash: resumed.txHash,
      },
      releaseId: restored.releaseId,
      approvals: ['ana', 'beto'],
    };
    writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
});
