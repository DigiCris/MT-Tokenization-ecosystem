#!/usr/bin/env node
// Copia local de los vectores de prueba cruzados (§10 regla 2): contracts/test/vectors/**.json → test/vectors/ byte a
// byte, más test/vectors/SHA256SUMS. Cada consumidor (backend, signer y cada frontend) guarda su propia copia; `--check`
// no escribe y falla si alguna difiere de la fuente (lo corre CI).
//
// Uso (desde la app): node scripts/sync-vectors.mjs [--check]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(APP_ROOT, '../../contracts/test/vectors');
const DEST = join(APP_ROOT, 'test/vectors');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function listJson(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return listJson(path, base);
      return name.endsWith('.json') ? [relative(base, path).split(sep).join('/')] : [];
    })
    .sort();
}

/** Ruta relativa a test/vectors → contenido esperado. */
function expected() {
  const files = new Map();
  const sums = [];
  for (const rel of listJson(SOURCE)) {
    const content = readFileSync(join(SOURCE, rel));
    files.set(rel, content);
    sums.push(`${sha256(content)}  ${rel}`);
  }
  files.set('SHA256SUMS', Buffer.from(`${sums.join('\n')}\n`));
  return files;
}

const files = expected();
if (files.size <= 1) {
  console.error(`no hay vectores en ${SOURCE}`);
  process.exit(1);
}

if (process.argv[2] === '--check') {
  const problems = [];
  for (const [rel, content] of files) {
    const path = join(DEST, rel);
    if (!existsSync(path)) problems.push(`falta test/vectors/${rel}`);
    else if (!readFileSync(path).equals(content))
      problems.push(`test/vectors/${rel} difiere de contracts/test/vectors`);
  }
  const extra = listJson(DEST).filter((rel) => !files.has(rel));
  for (const rel of extra) problems.push(`test/vectors/${rel} no existe en contracts/test/vectors`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`ERROR ${p}`);
    console.error('Regenerá la copia con `node scripts/sync-vectors.mjs`.');
    process.exit(1);
  }
  console.log(`VECTORES OK: ${String(files.size - 1)} archivos iguales a contracts/test/vectors`);
} else {
  rmSync(DEST, { recursive: true, force: true });
  for (const [rel, content] of files) {
    mkdirSync(dirname(join(DEST, rel)), { recursive: true });
    writeFileSync(join(DEST, rel), content);
  }
  console.log(`vectores copiados: ${String(files.size - 1)} archivos + SHA256SUMS`);
}
