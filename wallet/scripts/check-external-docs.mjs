#!/usr/bin/env node
// P03.T05: cada fila de docs/EXTERNAL_CONTRACTS.md coincide con config/chains/base-mainnet.json (clave, dirección y
// codehash) y cada contrato del JSON figura en la tabla. Sin dependencias.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkExternalDocs(root = ROOT) {
  const cfg = JSON.parse(readFileSync(join(root, 'config/chains/base-mainnet.json'), 'utf8'));
  const doc = readFileSync(join(root, 'docs/EXTERNAL_CONTRACTS.md'), 'utf8');
  const errors = [];
  const seen = new Set();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\| [^|]+ \| `([A-Za-z0-9]+)` \| `(0x[0-9a-fA-F]{40})` \| `(0x[0-9a-f]{64})` \|/);
    if (!m) continue;
    const [, key, address, codehash] = m;
    const c = cfg.contracts[key];
    if (!c) {
      errors.push(`${key}: no existe en base-mainnet.json`);
      continue;
    }
    seen.add(key);
    if (c.address !== address) errors.push(`${key}: dirección ${address} ≠ ${c.address}`);
    if (c.codehash !== codehash) errors.push(`${key}: codehash distinto del JSON`);
  }
  for (const key of Object.keys(cfg.contracts)) if (!seen.has(key)) errors.push(`${key}: falta en EXTERNAL_CONTRACTS.md`);
  const impl = cfg.contracts.usdc?.implementation;
  if (impl && !(doc.includes(impl.address) && doc.includes(impl.codehash))) errors.push('usdc: falta la implementación del proxy');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkExternalDocs();
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`);
    process.exit(1);
  }
  console.log('EXTERNAL_CONTRACTS OK');
}
