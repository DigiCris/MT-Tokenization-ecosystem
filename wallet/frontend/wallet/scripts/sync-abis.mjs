#!/usr/bin/env node
// Copia propia de la app de los ABIs de los contratos (§10 regla 2; independiente de las del backend y el signer):
// contracts/out-abi/*.json → src/chain/abis/<Nombre>.ts (`export const <nombre>Abi = [...] as const`, tipado para viem).
// `--check` no escribe y falla si alguna copia difiere de la fuente o sobra (lo corre CI).
//
// Uso (desde la app): node scripts/sync-abis.mjs [--check]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(APP_ROOT, '../../contracts/out-abi');
const DEST = join(APP_ROOT, 'src/chain/abis');

const camel = (name) => name.charAt(0).toLowerCase() + name.slice(1);

/** Nombre de archivo en src/chain/abis → contenido esperado. */
function expected() {
  const files = new Map();
  if (!existsSync(SOURCE)) return files;
  for (const file of readdirSync(SOURCE)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const name = file.slice(0, -'.json'.length);
    const abi = JSON.parse(readFileSync(join(SOURCE, file), 'utf8'));
    files.set(
      `${name}.ts`,
      `// Generado por scripts/sync-abis.mjs desde contracts/out-abi/${file}: no editar a mano.\n` +
        `export const ${camel(name)}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`,
    );
  }
  return files;
}

const files = expected();
if (files.size === 0) {
  console.error(`no hay ABIs en ${SOURCE}`);
  process.exit(1);
}

if (process.argv[2] === '--check') {
  const problems = [];
  for (const [name, content] of files) {
    const path = join(DEST, name);
    if (!existsSync(path)) problems.push(`falta src/chain/abis/${name}`);
    else if (readFileSync(path, 'utf8') !== content)
      problems.push(`src/chain/abis/${name} difiere de contracts/out-abi`);
  }
  const present = existsSync(DEST) ? readdirSync(DEST) : [];
  for (const name of present.filter((n) => !files.has(n))) {
    problems.push(`src/chain/abis/${name} no existe en contracts/out-abi`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`ERROR ${p}`);
    console.error('Regenerá la copia con `node scripts/sync-abis.mjs`.');
    process.exit(1);
  }
  console.log(`ABIS OK: ${String(files.size)} archivos iguales a contracts/out-abi`);
} else {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(DEST, name), content);
  console.log(`ABIs copiados: ${String(files.size)} archivos`);
}
