#!/usr/bin/env node
// `pnpm test:browser [filtro…]`: sincroniza los design tokens, compila la app y corre Playwright contra `vite preview`
// del build (los argumentos se pasan a `playwright test`, sin el `--` que agrega pnpm).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: APP_ROOT, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node', ['scripts/sync-design-tokens.mjs']);
run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn']);
run('pnpm', ['exec', 'playwright', 'test', ...args]);
