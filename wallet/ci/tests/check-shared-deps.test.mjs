// P16.T10 [F-SEC-09]: la regla de dependencias criptográficas comunes sobre repos de git temporales con commits
// fechados: un mismo upgrade de @noble/*, @scure/* o viem en Wallet y Recovery con menos de 72 h entre ambos falla
// (también si el segundo todavía no se commiteó); separados por más de 72 h, en paquetes distintos o al crear las apps,
// pasa. También el script de CI real sobre un repo temporal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSharedDeps, sharedVersions, upgraded } from '../scripts/check-shared-deps.mjs';

const CI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1_792_000_000;
const HOUR = 3600;

/** Lockfile mínimo con el formato de pnpm 12 (documento del propio pnpm + documento del proyecto). */
function lock(packages) {
  const entries = Object.entries(packages)
    .map(([name, version]) => `  '${name}@${version}':\n    resolution: {integrity: sha512-x}\n`)
    .join('\n');
  return `lockfileVersion: '9.0'\n\npackages:\n\n  '@pnpm/exe@12.14.0':\n    resolution: {integrity: sha512-y}\n\n---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n${entries}\nsnapshots:\n\n  react@19.3.0: {}\n`;
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'mtw-shared-deps-'));
  execFileSync('git', ['init', '-q', root]);
  for (const app of ['wallet', 'recovery']) mkdirSync(join(root, 'wallet/frontend', app), { recursive: true });
  return root;
}

function commit(root, time, changes) {
  for (const [app, packages] of Object.entries(changes)) {
    writeFileSync(join(root, 'wallet/frontend', app, 'pnpm-lock.yaml'), lock(packages));
  }
  const date = `@${time} +0000`;
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', `t${time}`], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

const base = { viem: '2.57.4', '@noble/hashes': '2.4.0', '@noble/curves': '2.4.0', react: '19.3.0' };

test('lee las versiones comunes de los dos documentos del lockfile y detecta upgrades (no altas)', () => {
  const v = sharedVersions(lock({ ...base, '@scure/base': '2.4.0' }));
  assert.deepEqual([...v.keys()].sort(), ['@noble/curves', '@noble/hashes', '@scure/base', 'viem']);
  assert.deepEqual(upgraded(new Map(), v), []);
  const bumped = sharedVersions(lock({ ...base, viem: '2.57.7', '@scure/base': '2.4.0' }));
  assert.deepEqual(upgraded(v, bumped), [{ name: 'viem', from: ['2.57.4'], to: ['2.57.7'] }]);
});

test('crear las dos apps con las mismas versiones no es un upgrade', () => {
  const root = repo();
  try {
    commit(root, T0, { wallet: base, recovery: base });
    assert.deepEqual(checkSharedDeps({ root }).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('el mismo upgrade en las dos apps con 24 h de diferencia falla; con 73 h pasa', () => {
  const root = repo();
  try {
    commit(root, T0, { wallet: base, recovery: base });
    commit(root, T0 + HOUR, { wallet: { ...base, viem: '2.57.7' } });
    commit(root, T0 + 25 * HOUR, { recovery: { ...base, viem: '2.57.7' } });
    const { violations } = checkSharedDeps({ root });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'viem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const later = repo();
  try {
    commit(later, T0, { wallet: base, recovery: base });
    commit(later, T0 + HOUR, { wallet: { ...base, '@noble/hashes': '2.4.1' } });
    commit(later, T0 + 74 * HOUR, { recovery: { ...base, '@noble/hashes': '2.4.1' } });
    assert.deepEqual(checkSharedDeps({ root: later }).violations, []);
  } finally {
    rmSync(later, { recursive: true, force: true });
  }
});

test('upgrades de paquetes distintos o de paquetes no criptográficos pasan', () => {
  const root = repo();
  try {
    commit(root, T0, { wallet: base, recovery: base });
    commit(root, T0 + HOUR, { wallet: { ...base, viem: '2.57.7', react: '19.3.1' } });
    commit(root, T0 + 2 * HOUR, { recovery: { ...base, '@noble/curves': '2.4.1', react: '19.3.1' } });
    assert.deepEqual(checkSharedDeps({ root }).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un upgrade todavía sin commitear también cuenta (y el script de CI falla con código 1)', () => {
  const root = repo();
  try {
    commit(root, T0, { wallet: base, recovery: base });
    commit(root, T0 + HOUR, { wallet: { ...base, '@noble/hashes': '2.4.1' } });
    writeFileSync(join(root, 'wallet/frontend/recovery/pnpm-lock.yaml'), lock({ ...base, '@noble/hashes': '2.4.1' }));
    const { violations } = checkSharedDeps({ root });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].recovery.commit, 'sin commitear');
    const run = spawnSync('node', [join(CI, 'scripts/check-shared-deps.mjs'), '--root', root], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /FALLA \[F-SEC-09\]: @noble\/hashes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
