#!/usr/bin/env node
// `pnpm dev` (P21.T02): todo el entorno local con un comando, sólo con node:child_process. En orden: preflight →
// docker compose (PostgreSQL, Valkey, Anvil sobre el fork, Mailpit) → migraciones del backend → deploy-local
// (idempotente) → snapshot de policy local firmado → shards del signer (dev-1 y platform) → seed-local (idempotente) →
// procesos con logs con prefijo: shards, API (8080/8081), worker (watcher, indexer y reconciliación), gas tank,
// integrity monitor en modo local (observa Wallet y Recovery; INTEGRITY_REQUIRED=false en local) y los frontends con
// Vite (Wallet 5173, Recovery 5174). Ctrl+C apaga en orden inverso. `pnpm dev:healthcheck` verifica todo.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend/app');
const SIGNER = join(ROOT, 'backend/signer');
const MONITOR = join(ROOT, 'backend/integrity-monitor');
const children = [];
const COLORS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94];

function step(label, command, args, options = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8', env: { ...process.env, ...options.env } });
  if (result.status !== 0 && !(options.tolerate && options.tolerate(`${result.stdout ?? ''}${result.stderr ?? ''}`))) {
    if (options.capture) process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.stderr.write(`dev: falló "${label}"\n`);
    shutdown(1);
  }
}

function start(name, command, args, cwd, env = {}) {
  const color = COLORS[children.length % COLORS.length];
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\u001b[${color}m${name.padEnd(16)}\u001b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk) => {
      const lines = (pending + chunk.toString()).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on('exit', (code, signal) => {
    if (!stopping) process.stdout.write(`${prefix}terminó (${signal ?? code})\n`);
  });
  children.push({ name, child });
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.stdout.write('\n▶ apagando en orden\n');
  for (const { child } of [...children].reverse()) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const env = (name, fallback = '') =>
  spawnSync('node', [join(ROOT, 'scripts/lib/env-value.mjs'), name], { encoding: 'utf8' }).stdout.trim() || fallback;

step('preflight', 'bash', ['scripts/preflight']);
step('docker compose up', 'docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '600']);
step('migraciones del backend', 'node', ['src/cli/db.ts', 'migrate'], { cwd: BACKEND });
step('deploy-local (idempotente)', 'bash', ['scripts/deploy-local']);
step('snapshot de policy local', 'node', ['scripts/policy-build.ts', '--env', 'local', '--deployment', join(ROOT, 'contracts/deployments/local.json'), '--out', resolve(ROOT, env('POLICY_SNAPSHOT_PATH', './config/policy/local/policy-snapshot.json'))], { cwd: SIGNER, env: { INIT_CWD: ROOT } });
step('firma del snapshot de policy', 'node', ['scripts/policy-sign.ts', resolve(ROOT, env('POLICY_SNAPSHOT_PATH', './config/policy/local/policy-snapshot.json'))], { cwd: SIGNER, env: { INIT_CWD: ROOT } });
const shardExists = (output) => /ya existe/.test(output);
step('shard dev-1 del signer', 'node', ['scripts/create-shard.ts'], { cwd: SIGNER, capture: true, tolerate: shardExists });
step('shard platform (gas tank)', 'node', ['scripts/create-shard.ts', '--shard', 'platform'], { cwd: SIGNER, capture: true, tolerate: shardExists });

start('signer dev-1', 'node', ['src/main.ts', 'serve'], SIGNER);
start('signer platform', 'node', ['src/main.ts', 'serve', '--shard', 'platform'], SIGNER);
start('api', 'node', ['src/main.ts', 'api'], BACKEND);
start('worker', 'node', ['src/main.ts', 'worker'], BACKEND);
start('gas-tank', 'node', ['src/main.ts', 'gas-tank'], BACKEND);
// El seed necesita el signer de desarrollo arriba (importa S) y la API para verificarse: después de los procesos.
setTimeout(() => {
  step('seed-local (idempotente)', 'bash', ['scripts/seed-local']);
  start('integrity', 'node', ['src/main.ts', 'serve'], MONITOR, {
    APP_ENV: 'local',
    PLATFORM_ID: env('PLATFORM_ID'),
    MONITOR_TARGETS: `WALLET=${env('WALLET_ORIGIN', 'http://localhost:5173')},RECOVERY=${env('RECOVERY_ORIGIN', 'http://localhost:5174')}`,
    WALLET_RELEASE_PUBLIC_KEY: env('WALLET_RELEASE_PUBLIC_KEY'),
    RECOVERY_RELEASE_PUBLIC_KEY: env('RECOVERY_RELEASE_PUBLIC_KEY'),
    MONITOR_ATTESTATION_PRIVATE_KEY: env('INTEGRITY_MONITOR_PRIVATE_KEY'),
    MONITOR_STATE_FILE: join(ROOT, '.secrets/integrity-monitor-state.json'),
  });
  start('wallet', 'pnpm', ['run', 'dev', '--port', '5173', '--strictPort'], join(ROOT, 'frontend/wallet'));
  start('recovery', 'pnpm', ['run', 'dev', '--port', '5174', '--strictPort'], join(ROOT, 'frontend/recovery'));
  process.stdout.write('\n▶ entorno local arriba: pnpm dev:healthcheck lo verifica (Ctrl+C para apagar)\n');
}, 15_000);
