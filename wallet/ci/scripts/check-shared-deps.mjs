#!/usr/bin/env node
// Regla de dependencias criptográficas comunes ([F-SEC-09], P16.T10): un upgrade de @noble/*, @scure/* o viem no se
// publica en Wallet y Recovery dentro de la misma ventana de 72 h. Recorre la historia de git de los lockfiles de las
// dos apps hasta HEAD (más los cambios sin commitear, en local) y falla si el mismo paquete cambió de versión en las
// dos apps con menos de 72 h entre ambos cambios. Sumar un paquete que la app no tenía no es un upgrade. "Ahora" es la
// fecha del commit HEAD: el resultado no depende de cuándo corre la CI. La aprobación de los revisores de cada dominio
// la exige CODEOWNERS (un dueño por app) en la protección de main.
//
// Uso: node ci/scripts/check-shared-deps.mjs [--root <repo>] [--window-hours 72]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const APPS = ['wallet/frontend/wallet', 'wallet/frontend/recovery'];
export const SHARED = /^(@noble\/[^@/]+|@scure\/[^@/]+|viem)$/;

/** Versiones resueltas de los paquetes comunes en un pnpm-lock.yaml (todas las secciones `packages`). */
export function sharedVersions(lockText) {
  const versions = new Map();
  for (const document of lockText.split(/^---$/m)) {
    const start = document.indexOf('\npackages:\n');
    if (start < 0) continue;
    const end = document.indexOf('\nsnapshots:\n', start);
    const section = document.slice(start, end < 0 ? undefined : end);
    for (const match of section.matchAll(/^ {2}'?(@?[^@\s':]+(?:\/[^@\s':]+)?)@([^\s':(]+)/gm)) {
      const [, name, version] = match;
      if (!SHARED.test(name)) continue;
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(version);
    }
  }
  return versions;
}

/** Paquetes comunes cuya versión cambió (estaban antes y siguen después, con otro conjunto de versiones). */
export function upgraded(before, after) {
  const out = [];
  for (const [name, now] of after) {
    const previous = before.get(name);
    if (previous === undefined || previous.size === 0) continue;
    const same = previous.size === now.size && [...now].every((v) => previous.has(v));
    if (!same) out.push({ name, from: [...previous].sort(), to: [...now].sort() });
  }
  return out;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function show(root, rev, path) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/** Upgrades de paquetes comunes de una app con fecha, desde `since` (epoch s) hasta HEAD y el árbol de trabajo. */
export function appUpgrades(root, app, since, now) {
  const path = `${app}/pnpm-lock.yaml`;
  const events = [];
  const log = git(root, ['log', '--format=%H %ct', `--since=@${since}`, 'HEAD', '--', path]);
  for (const line of log.split('\n').filter(Boolean)) {
    const [commit, time] = line.split(' ');
    const before = sharedVersions(show(root, `${commit}^`, path));
    const after = sharedVersions(show(root, commit, path));
    for (const change of upgraded(before, after)) events.push({ ...change, app, commit: commit.slice(0, 12), time: Number(time) });
  }
  const working = join(root, path);
  if (existsSync(working)) {
    const committed = show(root, 'HEAD', path);
    const current = readFileSync(working, 'utf8');
    if (current !== committed) {
      for (const change of upgraded(sharedVersions(committed), sharedVersions(current))) {
        events.push({ ...change, app, commit: 'sin commitear', time: now });
      }
    }
  }
  return events;
}

export function checkSharedDeps({ root, windowHours = 72 }) {
  const now = Number(git(root, ['log', '-1', '--format=%ct', 'HEAD']));
  const window = windowHours * 3600;
  const since = now - window;
  const [wallet, recovery] = APPS.map((app) => appUpgrades(root, app, since, now));
  const violations = [];
  for (const a of wallet) {
    for (const b of recovery) {
      if (a.name === b.name && Math.abs(a.time - b.time) < window) violations.push({ name: a.name, wallet: a, recovery: b });
    }
  }
  return { violations, upgrades: [...wallet, ...recovery] };
}

const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '../../..') },
      'window-hours': { type: 'string', default: '72' },
    },
  });
  const windowHours = Number(values['window-hours']);
  const { violations, upgrades } = checkSharedDeps({ root: resolve(values.root), windowHours });
  for (const u of upgrades) {
    console.log(`upgrade ${u.name} ${u.from.join('+')} → ${u.to.join('+')} en ${u.app} (${u.commit}, ${iso(u.time)})`);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      const hours = (Math.abs(v.wallet.time - v.recovery.time) / 3600).toFixed(1);
      console.error(
        `FALLA [F-SEC-09]: ${v.name} cambió en Wallet (${v.wallet.commit}, ${iso(v.wallet.time)}) y en Recovery ` +
          `(${v.recovery.commit}, ${iso(v.recovery.time)}) con ${hours} h entre ambos (mínimo ${windowHours} h).`,
      );
    }
    console.error('Publicá el upgrade en una sola app y el de la otra después de la ventana, con aprobación de cada dominio.');
    process.exit(1);
  }
  console.log(`dependencias comunes OK: ningún upgrade de @noble/*, @scure/* o viem en las dos apps dentro de ${windowHours} h`);
}
