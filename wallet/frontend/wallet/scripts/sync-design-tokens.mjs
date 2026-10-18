#!/usr/bin/env node
// Copia los design tokens (sólo CSS, fuentes y sus licencias) de wallet/frontend/design-tokens a
// src/styles/design-tokens/ de esta app verificando el SHA-256 de cada archivo contra design-tokens.lock.json
// (P16.T01). Sin dependencia npm compartida con la otra app: un cambio en los tokens se adopta en cada app por
// separado, actualizando su lock (`--pin`) en un commit revisado.
//
// Uso: node scripts/sync-design-tokens.mjs            verifica la fuente y copia
//      node scripts/sync-design-tokens.mjs --check    verifica fuente y copia (si existe) sin escribir
//      node scripts/sync-design-tokens.mjs --pin      fija en el lock los hashes actuales de la fuente
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(APP_ROOT, '../design-tokens');
const DEST = join(APP_ROOT, 'src/styles/design-tokens');
const LOCK = join(APP_ROOT, 'design-tokens.lock.json');
/** Lo que se copia: el CSS, las fuentes y sus licencias (el README de la fuente no). */
const INCLUDED = /^(tokens\.css|LICENSES|fonts\/[a-z0-9-]+\.woff2)$/;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function listFiles(dir, root = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, root) : [relative(root, full).split(sep).join('/')];
  });
}

/** Lock `{ source, files: [{ path, sha256 }] }` → mapa ruta → SHA-256. */
function readLock() {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  return Object.fromEntries(lock.files.map((file) => [file.path, file.sha256]));
}

function verify(dir, expected, label) {
  const problems = [];
  const found = listFiles(dir).filter((f) => INCLUDED.test(f));
  for (const [file, hash] of Object.entries(expected)) {
    const path = join(dir, file);
    if (!existsSync(path)) problems.push(`${label}: falta ${file}`);
    else if (sha256(path) !== hash) problems.push(`${label}: ${file} no coincide con el SHA-256 del lock`);
  }
  for (const file of found) if (!(file in expected)) problems.push(`${label}: ${file} no está en el lock`);
  return problems;
}

const mode = process.argv[2] ?? 'sync';
if (!['sync', '--check', '--pin'].includes(mode)) {
  console.error('uso: sync-design-tokens.mjs [--check | --pin]');
  process.exit(2);
}

if (mode === '--pin') {
  const files = listFiles(SOURCE)
    .filter((f) => INCLUDED.test(f))
    .sort()
    .map((path) => ({ path, sha256: sha256(join(SOURCE, path)) }));
  writeFileSync(LOCK, `${JSON.stringify({ source: '../design-tokens', files }, null, 2)}\n`);
  console.log(`design-tokens.lock.json fijado (${String(files.length)} archivos)`);
  process.exit(0);
}

const expected = readLock();
const problems = verify(SOURCE, expected, 'design-tokens');
if (mode === '--check' && existsSync(DEST)) problems.push(...verify(DEST, expected, 'copia de la app'));
if (problems.length > 0) {
  for (const p of problems) console.error(`ERROR ${p}`);
  console.error(
    'Si el cambio de tokens es intencional: revisalo y fijalo con `node scripts/sync-design-tokens.mjs --pin`.',
  );
  process.exit(1);
}

if (mode === 'sync') {
  rmSync(DEST, { recursive: true, force: true });
  for (const file of Object.keys(expected)) {
    mkdirSync(dirname(join(DEST, file)), { recursive: true });
    copyFileSync(join(SOURCE, file), join(DEST, file));
  }
  const copied = verify(DEST, expected, 'copia de la app');
  if (copied.length > 0) {
    for (const p of copied) console.error(`ERROR ${p}`);
    process.exit(1);
  }
}
console.log(`design tokens OK (${String(Object.keys(expected).length)} archivos, SHA-256 verificados)`);
