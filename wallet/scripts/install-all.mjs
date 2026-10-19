#!/usr/bin/env node
// `pnpm install` en wallet/ (P21.T01, hook postinstall): instala cada proyecto con su propio lockfile congelado (no hay
// dependencias en la raíz) y las dependencias de contratos con Soldeer verificadas por hash (script/verify-deps.sh).
// Sale con el primer error. Sin red para lo que ya está instalado (pnpm reutiliza el store).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = ['backend/app', 'backend/signer', 'backend/integrity-monitor', 'frontend/wallet', 'frontend/recovery', 'tools/sovereign-exit', 'e2e'];

function run(label, command, args, cwd) {
  process.stdout.write(`install-all: ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: process.env.CI ?? 'true' } });
  if (result.status !== 0) {
    process.stderr.write(`install-all: falló ${label}\n`);
    process.exit(result.status ?? 1);
  }
}

for (const project of PROJECTS) {
  const dir = join(ROOT, project);
  if (!existsSync(join(dir, 'package.json'))) continue;
  run(`${project} (pnpm install --frozen-lockfile)`, 'pnpm', ['install', '--frozen-lockfile', '--config.confirmModulesPurge=false'], dir);
}
run('contracts (forge soldeer install)', 'forge', ['soldeer', 'install'], join(ROOT, 'contracts'));
run('contracts (verificación de dependencias)', 'bash', ['script/verify-deps.sh'], join(ROOT, 'contracts'));
