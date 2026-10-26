#!/usr/bin/env node
// E2E de MT Wallet (P22) sobre el stack local real: `pnpm test [filtro…]` (los argumentos van a `playwright test`, sin
// el `--` que agrega pnpm):
//  1. navegadores en la imagen fijada de Playwright si hacen falta (wallet/scripts/lib/browser-server.mjs);
//  2. un solo stack aislado para las dos apps (wallet/scripts/stack/stack.mjs: PostgreSQL, Valkey, Mailpit, Anvil sobre
//     el fork, contratos del sistema, signer, API, worker y gas tank) con los orígenes de las dos vistas previas;
//  3. build de la Wallet y de Recovery contra ese stack (install congelado, design tokens verificados, entorno `ci` con
//     las URLs, los contratos y la clave de atestación del stack);
//  4. `playwright test` (playwright.config.ts levanta las dos vistas previas) y, pase lo que pase, desarma todo.
// Dos fases, cada una con su stack: todos los specs con los emails en Mailpit y, si el filtro lo incluye, el de entrega
// real (specs/real-email.spec.ts, P22.T06) con el stack mandando por Mailgun (en Chromium: la entrega no depende del
// navegador y la cuota diaria del sandbox es chica).
// Navegadores: MTW_BROWSERS (por defecto la matriz de P22.T05: chromium,firefox,webkit). Nunca imprime secretos.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WALLET_ROOT = resolve(E2E_ROOT, '..');
const APPS = { wallet: join(WALLET_ROOT, 'frontend/wallet'), recovery: join(WALLET_ROOT, 'frontend/recovery') };
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
const WALLET_PORT = process.env.MTW_E2E_WALLET_PORT ?? '4274';
const RECOVERY_PORT = process.env.MTW_E2E_RECOVERY_PORT ?? '5274';
const walletOrigin = `http://localhost:${WALLET_PORT}`;
const recoveryOrigin = `http://localhost:${RECOVERY_PORT}`;
/** Cliente OAuth de prueba: el consentimiento de Google lo responde el test con un token real (fixtures/drive.ts). */
const TEST_OAUTH_CLIENT = 'mtw-browser-tests.apps.googleusercontent.com';

process.env.MTW_BROWSERS ??= 'chromium,firefox,webkit';

function run(command, commandArgs, { cwd = E2E_ROOT, env = process.env, capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1);
  return result;
}

/** Cuántos tests elige el filtro en una fase (sin levantar nada si no hay ninguno). */
function listed(env) {
  const result = run('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json', ...args], {
    env: { ...process.env, ...env },
    capture: true,
    allowFailure: true,
  });
  try {
    const report = JSON.parse(result.stdout);
    const count = (suite) => (suite.specs?.length ?? 0) + (suite.suites ?? []).reduce((n, s) => n + count(s), 0);
    return (report.suites ?? []).reduce((n, s) => n + count(s), 0);
  } catch {
    return 0;
  }
}

const PHASES = [
  { name: 'emails en Mailpit', email: 'smtp', env: {} },
  { name: 'entrega real por Mailgun', email: 'mailgun', env: { MTW_E2E_EMAIL: 'mailgun', MTW_BROWSERS: 'chromium' } },
].map((phase) => ({ ...phase, tests: listed(phase.env) }));
if (PHASES.every((phase) => phase.tests === 0)) {
  process.stderr.write(`test:e2e: ningún test coincide con ${args.join(' ') || '(sin filtro)'}\n`);
  process.exit(1);
}

// Navegadores en el contenedor si hacen falta (como proceso); se borra al salir, también si un paso falla.
const browserDir = mkdtempSync(join(tmpdir(), 'mtw-e2e-browsers-'));
const browserState = join(browserDir, 'state.json');
const browserCli = join(WALLET_ROOT, 'scripts/lib/browser-server.mjs');
process.on('exit', () => {
  spawnSync('node', [browserCli, 'stop', '--state', browserState], { stdio: 'ignore' });
  rmSync(browserDir, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));
run('node', [browserCli, 'start', '--project', E2E_ROOT, '--state', browserState]);
const { wsEndpoint } = JSON.parse(readFileSync(browserState, 'utf8'));
const browserEnv = wsEndpoint ? { PW_TEST_CONNECT_WS_ENDPOINT: wsEndpoint } : {};

/** Una fase: stack aislado (con el email indicado), build de las dos apps contra él, Playwright y desarme. */
function runPhase(phase) {
  process.stderr.write(`test:e2e: fase «${phase.name}» (${String(phase.tests)} tests)\n`);
  // Fuera de test-results/: Playwright vacía ese directorio al empezar cada corrida.
  const stateDir = mkdtempSync(join(tmpdir(), 'mtw-e2e-stack-'));
  const stateFile = join(stateDir, 'state.json');
  const stackCli = join(WALLET_ROOT, 'scripts/stack/stack.mjs');
  const started = run(
    'node',
    [
      stackCli,
      'up',
      '--state',
      stateFile,
      '--wallet-origin',
      walletOrigin,
      '--recovery-origin',
      recoveryOrigin,
      '--email',
      phase.email,
    ],
    { allowFailure: true },
  );
  if (started.status !== 0) {
    rmSync(stateDir, { recursive: true, force: true });
    return started.status ?? 1;
  }
  let status = 1;
  const logs = join(JSON.parse(readFileSync(stateFile, 'utf8')).dir, 'logs');
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const common = {
      ...process.env,
      MTW_ENV: 'ci',
      PLATFORM_ID: state.platformId,
      SIGNER_ATTESTATION_PUBLIC_KEY: state.signerAttestationPublicKey,
      MTW_DEPLOYMENT_FILE: state.deploymentFile,
    };
    const builds = {
      wallet: {
        ...common,
        WALLET_API_BASE_URL: state.urls.apiWallet,
        WALLET_FRONTEND_RPC_URL: state.urls.anvil,
        RECOVERY_ORIGIN: recoveryOrigin,
        GOOGLE_CLIENT_ID_WALLET: TEST_OAUTH_CLIENT,
        GOOGLE_OAUTH_REDIRECT_URI_WALLET: `${walletOrigin}/oauth/google/callback`,
      },
      recovery: {
        ...common,
        RECOVERY_API_BASE_URL: state.urls.apiRecovery,
        RECOVERY_FRONTEND_RPC_URL: state.urls.anvil,
        WALLET_ORIGIN: walletOrigin,
        GOOGLE_CLIENT_ID_RECOVERY: TEST_OAUTH_CLIENT,
        GOOGLE_OAUTH_REDIRECT_URI_RECOVERY: `${recoveryOrigin}/oauth/google/callback`,
      },
    };
    for (const [app, env] of Object.entries(builds)) {
      run('pnpm', ['install', '--frozen-lockfile'], { cwd: APPS[app] });
      run('node', ['scripts/sync-design-tokens.mjs'], { cwd: APPS[app] });
      run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], { cwd: APPS[app], env });
    }
    const result = run('pnpm', ['exec', 'playwright', 'test', ...args], {
      env: {
        ...process.env,
        ...browserEnv,
        ...phase.env,
        MTW_STACK_STATE: stateFile,
        MTW_E2E_WALLET_PORT: WALLET_PORT,
        MTW_E2E_RECOVERY_PORT: RECOVERY_PORT,
      },
      allowFailure: true,
    });
    status = result.status ?? 1;
  } finally {
    run('node', [stackCli, 'down', '--state', stateFile, ...(status === 0 ? [] : ['--keep-logs'])], {
      allowFailure: true,
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (status !== 0) process.stderr.write(`test:e2e: logs del stack en ${logs}\n`);
  return status;
}

let failed = 0;
for (const phase of PHASES) {
  if (phase.tests > 0 && runPhase(phase) !== 0) failed++;
}
if (failed > 0) process.exit(1);
