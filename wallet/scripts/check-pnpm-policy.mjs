#!/usr/bin/env node
// Política de supply chain de pnpm (P01.T05, docs/VERSIONS.md#supply-chain). Con pnpm 12 sólo la
// autenticación y el registry se leen de .npmrc: el resto va en el pnpm-workspace.yaml de cada
// proyecto (https://pnpm.io/settings). Exige en cada proyecto pnpm de wallet/:
//   saveExact: true · strictPeerDependencies: true · minimumReleaseAge >= 10080 (7 días)
//   strictDepBuilds: true · allowBuilds (allowlist explícita, sin dangerouslyAllowAllBuilds)
// y versiones exactas en package.json.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS = ['backend/app', 'backend/signer', 'backend/integrity-monitor', 'frontend/wallet', 'frontend/recovery', 'e2e', 'tools/sovereign-exit', 'contracts'];
export const MIN_AGE_MINUTES = 7 * 24 * 60;
const EXACT = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|link:|file:)/;

/** Lector mínimo de las claves de primer nivel de un YAML simple (y del mapa allowBuilds). */
export function readWorkspaceYaml(text) {
  const top = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (m) {
      current = m[1];
      // `clave:` sola abre un mapa; `clave: {}` es un mapa vacío explícito (p. ej. allowBuilds sin excepciones).
      top[current] = m[2] === '' || m[2].trim() === '{}' ? {} : m[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const sub = line.match(/^\s+['"]?([^'":]+?)['"]?:\s*(.+)$/);
    if (sub && current && typeof top[current] === 'object') top[current][sub[1].trim()] = sub[2].trim();
  }
  return top;
}

export function checkPolicy(root = ROOT) {
  const errors = [];
  const checked = [];
  for (const p of PROJECTS) {
    const dir = join(root, p);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    checked.push(p);
    const wsPath = join(dir, 'pnpm-workspace.yaml');
    if (!existsSync(wsPath)) errors.push(`${p}: falta pnpm-workspace.yaml con la política de supply chain`);
    else {
      const ws = readWorkspaceYaml(readFileSync(wsPath, 'utf8'));
      if (ws.saveExact !== 'true') errors.push(`${p}: saveExact debe ser true`);
      if (ws.strictPeerDependencies !== 'true') errors.push(`${p}: strictPeerDependencies debe ser true`);
      if (!(Number(ws.minimumReleaseAge) >= MIN_AGE_MINUTES)) errors.push(`${p}: minimumReleaseAge debe ser >= ${MIN_AGE_MINUTES} (7 días)`);
      if (ws.strictDepBuilds !== 'true') errors.push(`${p}: strictDepBuilds debe ser true`);
      if (typeof ws.allowBuilds !== 'object') errors.push(`${p}: falta allowBuilds (allowlist explícita de scripts de instalación; puede estar vacía: {})`);
      if (ws.dangerouslyAllowAllBuilds === 'true') errors.push(`${p}: dangerouslyAllowAllBuilds está prohibido`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[section] ?? {})) {
        if (!EXACT.test(range)) errors.push(`${p}: ${name}@${range} no es una versión exacta`);
      }
    }
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? '')) errors.push(`${p}: packageManager debe ser pnpm@<versión exacta>`);
  }
  return { errors, checked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, checked } = checkPolicy();
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`);
    process.exit(1);
  }
  console.log(checked.length ? `política de pnpm OK en: ${checked.join(', ')}` : 'política de pnpm OK (todavía no hay proyectos pnpm)');
}
