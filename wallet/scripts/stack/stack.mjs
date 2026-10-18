#!/usr/bin/env node
// Stack local completo y aislado (P17: tests de navegador contra los servicios reales; base de `pnpm dev`, P21, y del
// E2E, P22). Sólo `node:`: un proyecto de docker compose propio (PostgreSQL, Valkey, Mailpit y Anvil sobre el fork de
// Base en el bloque fijado) con puertos libres, secretos locales nuevos en su propio .env (scripts/lib/secrets-local.mjs
// y `opaque:setup` con MTW_ENV_FILE), migraciones, deploy de los contratos del sistema (deploy-core sobre ese Anvil),
// snapshot de policy armado y firmado con la clave local de ese stack, shards `dev-1` y `platform` del signer, API
// (listeners de Wallet y Recovery), worker y gas tank. Nunca imprime secretos ni el RPC del fork.
//
//   node scripts/stack/stack.mjs up --state <archivo> --wallet-origin <url> [--recovery-origin <url>]
//   node scripts/stack/stack.mjs down --state <archivo>
//
// `up` deja los procesos corriendo en segundo plano y escribe en --state lo que necesitan los tests: URLs, puertos, el
// archivo de deployment y la clave pública de atestación del signer. Si algo falla, desarma lo que levantó.
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEnvFile, updateEnvFile } from '../preflight.d/lib/env.mjs';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKEND = join(WALLET_ROOT, 'backend/app');
const SIGNER = join(WALLET_ROOT, 'backend/signer');
const SERVICES = ['postgres', 'valkey', 'mailpit', 'anvil'];
// Fallas de red del fork (Anvil copiando estado del RPC de Base, o forge esperando a Anvil): no son del código. Con
// un Anvil nuevo (misma caché de RPC, ya más caliente) el deploy se reintenta una sola vez; cualquier otra falla corta.
const TRANSIENT_FORK_ERROR =
  /operation timed out|error sending request|failed to get (?:account|storage|block)|\b429\b|rate limit|connection (?:reset|refused|closed)/i;

function log(message) {
  process.stderr.write(`stack: ${message}\n`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function allocatePorts(names) {
  const ports = {};
  const used = new Set();
  for (const name of names) {
    let port;
    do port = await freePort();
    while (used.has(port));
    used.add(port);
    ports[name] = port;
  }
  return ports;
}

/** RPC del fork desde el entorno (CI: secret) o wallet/.env (local), sin imprimirlo. */
function forkRpcUrl() {
  const fromEnv = process.env.FORK_RPC_URL || process.env.BASE_RPC_URL;
  if (fromEnv) return fromEnv;
  const dotenv = readEnvFile(join(WALLET_ROOT, '.env')) ?? {};
  if (dotenv.BASE_RPC_URL) return dotenv.BASE_RPC_URL;
  throw new Error('falta BASE_RPC_URL (CI: secret del environment; local: wallet/.env)');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? WALLET_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (options.logFile) writeFileSync(options.logFile, `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'a' });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${options.label ?? command} falló (${String(result.status)}):\n${tail}`);
  }
  return result.stdout ?? '';
}

/** Entorno de los procesos del stack: sólo lo necesario + el .env propio (los loaders leen MTW_ENV_FILE). */
function processEnv(state, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    APP_ENV: 'local',
    MTW_ENV_FILE: state.envFile,
    ...extra,
  };
}

function startProcess(state, name, command, args, options) {
  const out = openSync(join(state.dir, 'logs', `${name}.log`), 'a');
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  state.processes.push({ name, pid: child.pid });
  saveState(state);
  return child;
}

function saveState(state) {
  const json = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(state.stateFile, json, { mode: 0o600 });
  // Copia en el directorio del stack: si el archivo de estado se pierde, `down --state <dir>/state.json` lo desarma igual.
  writeFileSync(join(state.dir, 'state.json'), json, { mode: 0o600 });
}

async function waitFor(label, check, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`${label} no quedó listo${last ? `: ${last.message}` : ''}`);
    await sleep(intervalMs);
  }
}

async function httpOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.ok;
}

/** GET /v1/health del shard por mTLS con el certificado de cliente del backend. */
function signerHealthy(url, env) {
  return new Promise((resolveHealth) => {
    const req = httpsRequest(
      `${url}/v1/health`,
      {
        ca: readFileSync(env.MTLS_CA_CERT_PATH),
        cert: readFileSync(env.MTLS_BACKEND_CLIENT_CERT_PATH),
        key: readFileSync(env.MTLS_BACKEND_CLIENT_KEY_PATH),
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolveHealth(res.statusCode === 200 && JSON.parse(body).ready === true);
          } catch {
            resolveHealth(false);
          }
        });
      },
    );
    req.on('error', () => resolveHealth(false));
    req.on('timeout', () => {
      req.destroy();
      resolveHealth(false);
    });
    req.end();
  });
}

async function anvilRpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function compose(state, args, label) {
  return run(
    'docker',
    [
      'compose',
      '-p',
      state.project,
      '--env-file',
      state.envFile,
      '-f',
      join(WALLET_ROOT, 'docker-compose.yml'),
      ...args,
    ],
    {
      env: { ...process.env, BASE_RPC_URL: forkRpcUrl() },
      label,
      logFile: join(state.dir, 'logs', 'compose.log'),
    },
  );
}

function ensureInstalled(project) {
  if (existsSync(join(project, 'node_modules'))) return;
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: project, label: `pnpm install en ${project}` });
}

export async function up({ stateFile, walletOrigin, recoveryOrigin }) {
  const dir = mkdtempSync(join(tmpdir(), 'mtw-stack-'));
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
  const id = dir
    .split('mtw-stack-')[1]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const ports = await allocatePorts([
    'postgres',
    'valkey',
    'mailpitSmtp',
    'mailpitUi',
    'anvil',
    'apiWallet',
    'apiRecovery',
    'metrics',
    'workerMetrics',
    'gasTankMetrics',
    'signer',
    'signerPlatform',
  ]);
  const state = {
    id,
    dir,
    stateFile: resolve(stateFile),
    envFile: join(dir, 'stack.env'),
    project: `mtw-stack-${id}`,
    ports,
    processes: [],
    composeUp: false,
  };
  mkdirSync(dirname(state.stateFile), { recursive: true });
  saveState(state);
  try {
    await bringUp(state, { walletOrigin, recoveryOrigin });
    return state;
  } catch (error) {
    log(`falló el arranque; logs en ${join(dir, 'logs')}`);
    await down({ stateFile: state.stateFile, keepLogs: true });
    throw error;
  }
}

async function bringUp(state, { walletOrigin, recoveryOrigin }) {
  const { dir, ports } = state;
  const chain = JSON.parse(readFileSync(join(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8'));
  const anvilUrl = `http://127.0.0.1:${String(ports.anvil)}`;
  const secrets = join(dir, 'secrets');
  // El signer de desarrollo sólo acepta keystores y credenciales bajo wallet/.secrets/signer/ (guarda de
  // DevelopmentSignerProvider): los de este stack van en su propio subdirectorio y se borran al desarmarlo.
  const signerSecrets = join(WALLET_ROOT, '.secrets/signer', `stack-${state.id}`);
  state.signerSecrets = signerSecrets;
  saveState(state);
  const example = readEnvFile(join(WALLET_ROOT, '.env.example')) ?? {};
  const overrides = {
    APP_ENV: 'local',
    PLATFORM_ID: example.PLATFORM_ID || 'mt-default',
    LOG_LEVEL: 'info',
    FORK_BLOCK_NUMBER: String(chain.fork.blockNumber),
    POSTGRES_HOST_PORT: String(ports.postgres),
    REDIS_HOST_PORT: String(ports.valkey),
    MAILPIT_SMTP_PORT: String(ports.mailpitSmtp),
    MAILPIT_UI_PORT: String(ports.mailpitUi),
    ANVIL_HOST_PORT: String(ports.anvil),
    LOCAL_RPC_URL: anvilUrl,
    API_WALLET_PORT: String(ports.apiWallet),
    API_RECOVERY_PORT: String(ports.apiRecovery),
    API_PUBLIC_URL_WALLET: `http://localhost:${String(ports.apiWallet)}`,
    API_PUBLIC_URL_RECOVERY: `http://localhost:${String(ports.apiRecovery)}`,
    WALLET_ORIGIN: walletOrigin,
    RECOVERY_ORIGIN: recoveryOrigin,
    METRICS_PORT: String(ports.metrics),
    WORKER_METRICS_PORT: String(ports.workerMetrics),
    GAS_TANK_METRICS_PORT: String(ports.gasTankMetrics),
    RPC_PRIMARY_URL: anvilUrl,
    RPC_SECONDARY_URL: anvilUrl,
    RPC_QUORUM_MODE: 'local-single',
    // Anvil trae el estado del fork bajo demanda: una lectura en frío puede tardar más que el timeout de un nodo real.
    RPC_TIMEOUT_MS: '30000',
    SIGNER_RPC_PRIMARY_URL: anvilUrl,
    SIGNER_RPC_SECONDARY_URL: anvilUrl,
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(ports.mailpitSmtp),
    SIGNER_PORT: String(ports.signer),
    SIGNER_PLATFORM_PORT: String(ports.signerPlatform),
    SIGNER_SHARDS: JSON.stringify([{ id: 'dev-1', url: `https://127.0.0.1:${String(ports.signer)}` }]),
    SIGNER_PLATFORM_URL: `https://127.0.0.1:${String(ports.signerPlatform)}`,
    SIGNER_KEYSTORE_DIR: join(signerSecrets, 'dev-1/keystore'),
    SIGNER_UNLOCK_CREDENTIAL_FILE: join(signerSecrets, 'dev-1/unlock.key'),
    SIGNER_PLATFORM_KEYSTORE_DIR: join(signerSecrets, 'platform/keystore'),
    SIGNER_PLATFORM_UNLOCK_CREDENTIAL_FILE: join(signerSecrets, 'platform/unlock.key'),
    MTLS_CA_CERT_PATH: join(secrets, 'mtls/ca.pem'),
    MTLS_BACKEND_CLIENT_CERT_PATH: join(secrets, 'mtls/backend-client.pem'),
    MTLS_BACKEND_CLIENT_KEY_PATH: join(secrets, 'mtls/backend-client-key.pem'),
    MTLS_SIGNER_SERVER_CERT_PATH: join(secrets, 'mtls/signer-server.pem'),
    MTLS_SIGNER_SERVER_KEY_PATH: join(secrets, 'mtls/signer-server-key.pem'),
    POLICY_SNAPSHOT_PATH: join(dir, 'policy-snapshot.json'),
    // Las URLs de conexión las compone secrets-local con los puertos y passwords nuevos.
    DATABASE_URL: '',
    DATABASE_MIGRATION_URL: '',
    SIGNER_DATABASE_URL: '',
    SIGNER_PLATFORM_DATABASE_URL: '',
    REDIS_URL: '',
    INTEGRITY_REQUIRED: 'false',
  };
  writeFileSync(state.envFile, '', { mode: 0o600 });
  updateEnvFile(state.envFile, { ...example, ...overrides });
  // Secretos locales nuevos (passwords, claves Ed25519, mTLS, keystores y credenciales) y el ServerSetup de OPAQUE.
  run('node', [join(WALLET_ROOT, 'scripts/lib/secrets-local.mjs')], {
    env: { ...process.env, APP_ENV: 'local', MTW_ENV_FILE: state.envFile },
    label: 'secrets-local',
  });
  run('node', ['src/cli/opaque-setup.ts'], {
    cwd: BACKEND,
    env: { ...process.env, APP_ENV: 'local', MTW_ENV_FILE: state.envFile },
    label: 'opaque:setup',
  });
  const env = readEnvFile(state.envFile);

  log(`servicios de compose (${state.project})`);
  state.composeUp = true;
  saveState(state);
  compose(state, ['up', '-d', '--wait', '--wait-timeout', '600', ...SERVICES], 'docker compose up');
  await waitFor('Anvil', async () => (await anvilRpc(anvilUrl, 'eth_chainId', [])) === '0x2105', 300_000, 2000);

  ensureInstalled(BACKEND);
  ensureInstalled(SIGNER);
  log('migraciones del backend');
  run('node', ['src/cli/db.ts', 'migrate'], {
    cwd: BACKEND,
    env: processEnv(state),
    label: 'db:migrate',
    logFile: join(dir, 'logs', 'migrate.log'),
  });

  log('contratos del sistema en el fork del stack');
  if (!existsSync(join(WALLET_ROOT, 'contracts/dependencies'))) {
    run('forge', ['soldeer', 'install'], { cwd: join(WALLET_ROOT, 'contracts'), label: 'forge soldeer install' });
  }
  const ciDeployment = join(WALLET_ROOT, 'contracts/deployments/ci.json');
  const previous = existsSync(ciDeployment) ? readFileSync(ciDeployment) : null;
  const deployLog = join(dir, 'logs', 'deploy.log');
  try {
    for (let attempt = 1; ; attempt++) {
      const offset = existsSync(deployLog) ? statSync(deployLog).size : 0;
      try {
        run('bash', [join(WALLET_ROOT, 'scripts/deploy-core'), 'ci'], {
          env: {
            ...process.env,
            LOCAL_RPC_URL: anvilUrl,
            LOCAL_SEED: env.LOCAL_SEED,
            DEPLOYER_KEY_SOURCE: 'local-seed',
            GOVERNANCE_SAFE_ADDRESS: '',
            POLICY_GUARDIANS: '',
          },
          label: 'deploy-core',
          logFile: deployLog,
        });
        break;
      } catch (error) {
        const output = existsSync(deployLog) ? readFileSync(deployLog).subarray(offset).toString('utf8') : '';
        if (attempt >= 2 || !TRANSIENT_FORK_ERROR.test(output)) throw error;
        log('deploy-core: el fork no obtuvo estado de Base a tiempo; se reinicia Anvil y se reintenta una vez');
        compose(state, ['restart', 'anvil'], 'docker compose restart anvil');
        await waitFor('Anvil', async () => (await anvilRpc(anvilUrl, 'eth_chainId', [])) === '0x2105', 300_000, 2000);
      }
    }
    copyFileSync(ciDeployment, join(dir, 'deployment.json'));
  } finally {
    if (previous === null) rmSync(ciDeployment, { force: true });
    else writeFileSync(ciDeployment, previous);
  }

  log('snapshot de policy firmado');
  const policyEnv = { ...processEnv(state), ...env, INIT_CWD: dir };
  run(
    'node',
    [
      'scripts/policy-build.ts',
      '--env',
      'local',
      '--deployment',
      join(dir, 'deployment.json'),
      '--out',
      join(dir, 'policy-snapshot.json'),
    ],
    {
      cwd: SIGNER,
      env: policyEnv,
      label: 'policy:build',
    },
  );
  run('node', ['scripts/policy-sign.ts', join(dir, 'policy-snapshot.json')], {
    cwd: SIGNER,
    env: policyEnv,
    label: 'policy:sign',
  });

  log('shards del signer');
  run('node', ['scripts/create-shard.ts'], { cwd: SIGNER, env: processEnv(state), label: 'shard:create dev-1' });
  const platform = JSON.parse(
    run('node', ['scripts/create-shard.ts', '--shard', 'platform'], {
      cwd: SIGNER,
      env: processEnv(state),
      label: 'shard:create platform',
    })
      .trim()
      .split('\n')
      .at(-1),
  );
  // La cuenta gas tank la fondea el operador; en el fork, 1 ETH.
  await anvilRpc(anvilUrl, 'anvil_setBalance', [platform.gasTank, '0xde0b6b3a7640000']);
  startProcess(state, 'signer-dev-1', 'node', ['src/main.ts', 'serve'], { cwd: SIGNER, env: processEnv(state) });
  startProcess(state, 'signer-platform', 'node', ['src/main.ts', 'serve', '--shard', 'platform'], {
    cwd: SIGNER,
    env: processEnv(state),
  });
  await waitFor('shard dev-1', () => signerHealthy(`https://127.0.0.1:${String(ports.signer)}`, env), 120_000);
  await waitFor(
    'shard platform',
    () => signerHealthy(`https://127.0.0.1:${String(ports.signerPlatform)}`, env),
    120_000,
  );

  log('API, worker y gas tank');
  startProcess(state, 'api', 'node', ['src/main.ts', 'api'], { cwd: BACKEND, env: processEnv(state) });
  startProcess(state, 'worker', 'node', ['src/main.ts', 'worker'], { cwd: BACKEND, env: processEnv(state) });
  startProcess(state, 'gas-tank', 'node', ['src/main.ts', 'gas-tank'], { cwd: BACKEND, env: processEnv(state) });
  await waitFor(
    'API de Wallet',
    () => httpOk(`http://127.0.0.1:${String(ports.apiWallet)}/api/v1/health/ready`),
    180_000,
  );
  await waitFor(
    'API de Recovery',
    () => httpOk(`http://127.0.0.1:${String(ports.apiRecovery)}/api/v1/health/ready`),
    60_000,
  );

  Object.assign(state, {
    platformId: env.PLATFORM_ID,
    deploymentFile: join(dir, 'deployment.json'),
    signerAttestationPublicKey: env.SIGNER_ATTESTATION_PUBLIC_KEY,
    urls: {
      apiWallet: `http://localhost:${String(ports.apiWallet)}/api/v1`,
      apiRecovery: `http://localhost:${String(ports.apiRecovery)}/api/v1`,
      mailpit: `http://127.0.0.1:${String(ports.mailpitUi)}`,
      anvil: anvilUrl,
    },
    gasTank: platform.gasTank,
    ready: true,
  });
  saveState(state);
  log(`listo: API de Wallet en ${state.urls.apiWallet}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function down({ stateFile, keepLogs = false }) {
  if (!existsSync(stateFile)) return;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const { pid } of [...state.processes].reverse()) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // ya terminó
    }
  }
  const deadline = Date.now() + 15_000;
  while (state.processes.some(({ pid }) => alive(pid)) && Date.now() < deadline) await sleep(250);
  for (const { pid } of state.processes) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ya terminó
    }
  }
  if (state.composeUp) {
    try {
      compose(state, ['down', '-v', '--remove-orphans', '--timeout', '10'], 'docker compose down');
    } catch (error) {
      log(error.message);
    }
  }
  if (state.signerSecrets) rmSync(state.signerSecrets, { recursive: true, force: true });
  if (!keepLogs) rmSync(state.dir, { recursive: true, force: true });
  else rmSync(join(state.dir, 'secrets'), { recursive: true, force: true });
  rmSync(stateFile, { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: 'string' },
      'wallet-origin': { type: 'string', default: 'http://localhost:5173' },
      'recovery-origin': { type: 'string', default: 'http://localhost:5174' },
      'keep-logs': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (!values.state || (command !== 'up' && command !== 'down')) {
    process.stderr.write('uso: node scripts/stack/stack.mjs up|down --state <archivo> [--wallet-origin <url>]\n');
    process.exit(2);
  }
  try {
    if (command === 'up') {
      await up({
        stateFile: values.state,
        walletOrigin: values['wallet-origin'],
        recoveryOrigin: values['recovery-origin'],
      });
    } else {
      await down({ stateFile: values.state, keepLogs: values['keep-logs'] });
    }
  } catch (error) {
    process.stderr.write(`stack: ${error.message}\n`);
    process.exit(1);
  }
}
