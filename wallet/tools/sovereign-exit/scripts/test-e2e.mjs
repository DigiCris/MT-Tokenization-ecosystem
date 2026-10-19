#!/usr/bin/env node
// `pnpm test:e2e`: compila la herramienta, levanta el stack aislado (fork de Base con los contratos del sistema) con
// scripts/stack/stack.mjs, apaga la plataforma (API, worker y gas tank: backend y frontends apagados, P19.T09), corre el
// E2E de Playwright con el HTML abierto desde el disco y desarma el stack (también si falla).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WALLET_ROOT = resolve(ROOT, '../..');
const STACK = join(WALLET_ROOT, 'scripts/stack/stack.mjs');
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));

function run(command, commandArgs, env = process.env, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env });
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  return result;
}

run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn']);
const stateDir = mkdtempSync(join(tmpdir(), 'mtw-sovereign-exit-stack-'));
const stateFile = join(stateDir, 'state.json');
const started = run('node', [STACK, 'up', '--state', stateFile], process.env, { allowFailure: true });
if (started.status !== 0) {
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(started.status ?? 1);
}
let status = 1;
const logs = join(JSON.parse(readFileSync(stateFile, 'utf8')).dir, 'logs');
try {
  run('node', [STACK, 'backend-stop', '--state', stateFile]);
  const result = run(
    'pnpm',
    ['exec', 'playwright', 'test', ...args],
    { ...process.env, MTW_STACK_STATE: stateFile },
    { allowFailure: true },
  );
  status = result.status ?? 1;
} finally {
  run('node', [STACK, 'down', '--state', stateFile, ...(status === 0 ? [] : ['--keep-logs'])], process.env, {
    allowFailure: true,
  });
  rmSync(stateDir, { recursive: true, force: true });
}
if (status !== 0) {
  process.stderr.write(`test:e2e: logs del stack en ${logs}\n`);
  process.exit(status);
}
