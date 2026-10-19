#!/usr/bin/env node
// Copia propia de Recovery de los ABIs de los contratos del sistema (§10 regla 2; independiente de la de Wallet, del
// backend y del signer): cada contracts/out-abi/<Nombre>.json → src/chain/abis/<Nombre>.ts como `export const
// <nombre>Abi = [...] as const` (tipado para viem). `--check` no escribe: falla si una copia difiere, falta o sobra.
//
// Uso (desde la app): node scripts/sync-abis.mjs [--check]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(APP_ROOT, '../../contracts/out-abi');
const TARGET = join(APP_ROOT, 'src/chain/abis');

function generated() {
  const out = new Map();
  if (!existsSync(SOURCE)) return out;
  for (const file of readdirSync(SOURCE).sort()) {
    if (!file.endsWith('.json')) continue;
    const contract = file.slice(0, -5);
    const constant = `${contract[0].toLowerCase()}${contract.slice(1)}Abi`;
    const abi = JSON.parse(readFileSync(join(SOURCE, file), 'utf8'));
    out.set(
      `${contract}.ts`,
      `// Generado por scripts/sync-abis.mjs desde contracts/out-abi/${file}: no editar a mano.\n` +
        `export const ${constant} = ${JSON.stringify(abi, null, 2)} as const;\n`,
    );
  }
  return out;
}

const wanted = generated();
if (wanted.size === 0) {
  console.error(`sin ABIs en ${SOURCE}: compilá los contratos (forge build) y exportalos`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const errors = [];
  const present = new Set(existsSync(TARGET) ? readdirSync(TARGET) : []);
  for (const [file, content] of wanted) {
    if (!present.has(file)) errors.push(`falta src/chain/abis/${file}`);
    else if (readFileSync(join(TARGET, file), 'utf8') !== content) errors.push(`src/chain/abis/${file} desactualizado`);
  }
  for (const file of present) if (!wanted.has(file)) errors.push(`src/chain/abis/${file} sobra`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    console.error('Regenerá con `node scripts/sync-abis.mjs`.');
    process.exit(1);
  }
  console.log(`ABIS OK: ${String(wanted.size)} copias iguales a contracts/out-abi`);
} else {
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  for (const [file, content] of wanted) writeFileSync(join(TARGET, file), content);
  console.log(`ABIs: ${String(wanted.size)} archivos en src/chain/abis`);
}
