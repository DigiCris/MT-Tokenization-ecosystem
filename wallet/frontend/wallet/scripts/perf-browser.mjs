#!/usr/bin/env node
// `pnpm test:browser -- perf/argon2` (P17.T08): rendimiento de Argon2id en el perfil móvil de referencia con la CPU 4×
// más lenta en Chromium y WebKit. Compila la app, sirve la vista previa en el host y corre playwright.perf.config.ts
// dentro de la imagen fijada de Playwright (scripts/tools/versions.json → testImages.playwright, con WebKit y sus
// dependencias) con `--cpus 0.25`. Antes de medir verifica que la cuota de CPU se aplique de verdad (un bucle de CPU
// de un hilo tiene que tardar ≥ 3× más dentro del límite): Docker rootless sin cgroups la ignora en silencio, y en ese
// caso no se mide (en CI falla; en local lo informa con el motivo, o falla con MTW_PERF_REQUIRED=1).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WALLET_ROOT = resolve(APP_ROOT, '../..');
const IMAGE = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')).testImages.playwright;
const CPUS = '0.25';
const PORT = Number(process.env.MTW_PERF_PORT ?? 4175);
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: APP_ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture) process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(result.status ?? 1);
  }
  return result;
}

/**
 * Milisegundos de un bucle de CPU de un hilo en un contenedor, con o sin límite. Se calibra con la imagen fijada de
 * PostgreSQL del stack (liviana y ya presente): si la cuota no se aplica no hace falta bajar la de Playwright.
 */
const CALIBRATION_IMAGE = JSON.parse(readFileSync(join(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')).images
  .postgres;

function loopMs(limited) {
  const result = run(
    'docker',
    [
      'run',
      '--rm',
      ...(limited ? ['--cpus', CPUS] : []),
      '--entrypoint',
      'bash',
      CALIBRATION_IMAGE,
      '-c',
      's=$(date +%s%N); i=0; while [ $i -lt 1500000 ]; do i=$((i+1)); done; e=$(date +%s%N); echo $(( (e-s)/1000000 ))',
    ],
    { capture: true },
  );
  return Number(result.stdout.trim().split('\n').at(-1));
}

run('node', ['scripts/sync-design-tokens.mjs']);
const calibration = run('docker', ['image', 'inspect', CALIBRATION_IMAGE], { capture: true, allowFailure: true });
if (calibration.status !== 0) run('docker', ['pull', '-q', CALIBRATION_IMAGE]);

const free = loopMs(false);
const limited = loopMs(true);
const factor = limited / free;
process.stderr.write(
  `perf: bucle de CPU ${String(free)} ms sin límite, ${String(limited)} ms con --cpus ${CPUS} (${factor.toFixed(2)}×)\n`,
);
if (!(factor >= 3)) {
  const reason = `la cuota de CPU de Docker no se aplica en este entorno (${factor.toFixed(2)}×; Docker rootless sin cgroups la ignora)`;
  if (process.env.GITHUB_ACTIONS) {
    process.stderr.write(`perf: ${reason}\n`);
    process.exit(1);
  }
  process.stderr.write(`perf: no se mide: ${reason}. La medición con la CPU limitada corre en CI.\n`);
  process.exit(process.env.MTW_PERF_REQUIRED === '1' ? 1 : 0);
}

const pulled = run('docker', ['image', 'inspect', IMAGE], { capture: true, allowFailure: true });
if (pulled.status !== 0) run('docker', ['pull', '-q', IMAGE]);
run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn']);
const preview = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  {
    cwd: APP_ROOT,
    stdio: 'ignore',
    detached: true,
  },
);
let status;
try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(PORT)}/`)).ok) break;
    } catch {
      // arrancando
    }
    if (Date.now() > deadline) throw new Error('la vista previa no arrancó');
    await sleep(500);
  }
  const result = run(
    'docker',
    [
      'run',
      '--rm',
      '--cpus',
      CPUS,
      '--network',
      'host',
      '--ipc',
      'host',
      '-v',
      `${APP_ROOT}:/app`,
      '-w',
      '/app',
      '-e',
      `MTW_PERF_BASE_URL=http://127.0.0.1:${String(PORT)}`,
      '-e',
      `MTW_PERF_CPUS=${CPUS}`,
      '-e',
      `MTW_PERF_CPU_FACTOR=${factor.toFixed(2)}`,
      ...(process.env.MTW_ARGON2_SAMPLES ? ['-e', `MTW_ARGON2_SAMPLES=${process.env.MTW_ARGON2_SAMPLES}`] : []),
      ...(process.env.CI ? ['-e', 'CI=1'] : []),
      '--entrypoint',
      'node',
      IMAGE,
      'node_modules/@playwright/test/cli.js',
      'test',
      '-c',
      'playwright.perf.config.ts',
      ...args.filter((a) => !/^perf(\/argon2)?(\.spec\.ts)?$/.test(a)),
    ],
    { allowFailure: true },
  );
  status = result.status ?? 1;
} finally {
  try {
    process.kill(-preview.pid, 'SIGTERM');
  } catch {
    // ya terminó
  }
}
process.exit(status ?? 1);
