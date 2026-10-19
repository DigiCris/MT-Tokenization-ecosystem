#!/usr/bin/env node
// `pnpm test:browser [filtro…]` (los argumentos van a `playwright test`, sin el `--` que agrega pnpm):
//  1. specs sin backend (playwright.config.ts: headers y Trusted Types) contra `vite preview` del build local;
//  2. specs contra el stack real (playwright.stack.config.ts): si el filtro incluye alguno, levanta el stack aislado
//     con scripts/stack/stack.mjs (Recovery como RECOVERY_ORIGIN del backend), compila la app con las URLs, los
//     contratos y la clave de atestación de ese stack, corre los specs y desarma el stack (también si fallan).
// Navegadores: MTW_BROWSERS (por defecto, chromium; p. ej. `chromium,firefox`). Fuera de GitHub Actions, Firefox y WebKit
// corren en la imagen fijada de Playwright (wallet/scripts/lib/browser-server.mjs, invocado como proceso).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../build/env-file.ts';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WALLET_ROOT = resolve(APP_ROOT, '../..');
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
const STACK_PREVIEW_PORT = process.env.MTW_STACK_PREVIEW_PORT ?? '5175';
// Origin de Wallet que espera el backend del stack: sólo lo usan los clientes de Node de los tests (header Origin) y el
// link de regreso de Recovery; no se sirve ninguna Wallet.
const STACK_WALLET_ORIGIN = 'http://localhost:4174';

function run(command, commandArgs, env = process.env, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: APP_ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  return result;
}

function listed(config) {
  const result = run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', config, '--list', '--reporter=json', ...args],
    process.env,
    {
      capture: true,
      allowFailure: true,
    },
  );
  try {
    const report = JSON.parse(result.stdout);
    const count = (suite) => (suite.specs?.length ?? 0) + (suite.suites ?? []).reduce((n, s) => n + count(s), 0);
    return (report.suites ?? []).reduce((n, s) => n + count(s), 0);
  } catch {
    return 0;
  }
}

/** Valor público del entorno o de wallet/.env (nunca se imprime). */
function publicValue(name) {
  return process.env[name] || (readEnvFile(join(WALLET_ROOT, '.env')) ?? {})[name] || '';
}

run('node', ['scripts/sync-design-tokens.mjs']);

const staticSpecs = listed('playwright.config.ts');
const stackSpecs = listed('playwright.stack.config.ts');
if (staticSpecs === 0 && stackSpecs === 0) {
  process.stderr.write(`test:browser: ningún test coincide con ${args.join(' ') || '(sin filtro)'}\n`);
  process.exit(1);
}

// Navegadores en el contenedor si hacen falta; el contenedor se borra al salir, también si un paso falla.
const browserDir = mkdtempSync(join(tmpdir(), 'mtw-browsers-'));
const browserState = join(browserDir, 'state.json');
const browserCli = join(WALLET_ROOT, 'scripts/lib/browser-server.mjs');
process.on('exit', () => {
  spawnSync('node', [browserCli, 'stop', '--state', browserState], { stdio: 'ignore' });
  rmSync(browserDir, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));
run('node', [browserCli, 'start', '--project', APP_ROOT, '--state', browserState]);
const { wsEndpoint } = JSON.parse(readFileSync(browserState, 'utf8'));
const browserEnv = wsEndpoint ? { PW_TEST_CONNECT_WS_ENDPOINT: wsEndpoint } : {};

if (staticSpecs > 0) {
  // Con un cliente OAuth de prueba (Google se simula en el spec): el viaje de OAuth de Drive desde /enroll
  // (enroll-drive-oauth.spec.ts) necesita que la app ofrezca Drive.
  const staticEnv = {
    ...process.env,
    GOOGLE_CLIENT_ID_RECOVERY: process.env.GOOGLE_CLIENT_ID_RECOVERY || 'mtw-browser-tests.apps.googleusercontent.com',
  };
  run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], staticEnv);
  run('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.config.ts', ...args], { ...staticEnv, ...browserEnv });
}

if (stackSpecs > 0) {
  // Fuera de test-results/: Playwright vacía ese directorio al empezar cada corrida.
  const stateDir = mkdtempSync(join(tmpdir(), 'mtw-recovery-stack-'));
  const stateFile = join(stateDir, 'state.json');
  const stackCli = join(WALLET_ROOT, 'scripts/stack/stack.mjs');
  const recoveryOrigin = `http://localhost:${STACK_PREVIEW_PORT}`;
  const started = run(
    'node',
    [stackCli, 'up', '--state', stateFile, '--wallet-origin', STACK_WALLET_ORIGIN, '--recovery-origin', recoveryOrigin],
    process.env,
    { allowFailure: true },
  );
  if (started.status !== 0) {
    rmSync(stateDir, { recursive: true, force: true });
    process.exit(started.status ?? 1);
  }
  let status = 1;
  const logs = join(JSON.parse(readFileSync(stateFile, 'utf8')).dir, 'logs');
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const walletConnectProjectId = publicValue('WALLETCONNECT_PROJECT_ID');
    const buildEnv = {
      ...process.env,
      MTW_ENV: 'ci',
      PLATFORM_ID: state.platformId,
      RECOVERY_API_BASE_URL: state.urls.apiRecovery,
      RECOVERY_FRONTEND_RPC_URL: state.urls.anvil,
      WALLET_ORIGIN: STACK_WALLET_ORIGIN,
      // El consentimiento de Google lo responde el test con un token real de la cuenta de prueba (Google no se contacta).
      GOOGLE_CLIENT_ID_RECOVERY: 'mtw-browser-tests.apps.googleusercontent.com',
      GOOGLE_OAUTH_REDIRECT_URI_RECOVERY: `${recoveryOrigin}/oauth/google/callback`,
      SIGNER_ATTESTATION_PUBLIC_KEY: state.signerAttestationPublicKey,
      MTW_DEPLOYMENT_FILE: state.deploymentFile,
      ...(walletConnectProjectId === '' ? {} : { WALLETCONNECT_PROJECT_ID: walletConnectProjectId }),
    };
    run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], buildEnv);
    const result = run(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.stack.config.ts', ...args],
      {
        ...process.env,
        ...browserEnv,
        MTW_STACK_STATE: stateFile,
        MTW_STACK_PREVIEW_PORT: STACK_PREVIEW_PORT,
        MTW_STACK_WALLET_ORIGIN: STACK_WALLET_ORIGIN,
      },
      { allowFailure: true },
    );
    status = result.status ?? 1;
  } finally {
    run('node', [stackCli, 'down', '--state', stateFile, ...(status === 0 ? [] : ['--keep-logs'])], process.env, {
      allowFailure: true,
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (status !== 0) {
    process.stderr.write(`test:browser: logs del stack en ${logs}\n`);
    process.exit(status);
  }
}
