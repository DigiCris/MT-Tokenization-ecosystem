#!/usr/bin/env node
// Verifica MTW-WORDLIST-V1 (P01.T08, ADR-013): 65.536 entradas únicas [a-z]+, en el orden
// original de niceware 4.0.0 (ordenado), LF final, y SHA-256 exacto.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_SHA256 = 'c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e';

export function verifyWordlist(root = ROOT) {
  const errors = [];
  const raw = readFileSync(join(root, 'config/wordlist/mtw-wordlist-v1.txt'));
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== EXPECTED_SHA256) errors.push(`SHA-256 ${sha} ≠ ${EXPECTED_SHA256}`);
  const recorded = readFileSync(join(root, 'config/wordlist/mtw-wordlist-v1.sha256'), 'utf8').trim().split(/\s+/)[0];
  if (recorded !== EXPECTED_SHA256) errors.push('mtw-wordlist-v1.sha256 no coincide con el hash esperado');
  const text = raw.toString('utf8');
  if (!text.endsWith('\n') || text.includes('\r')) errors.push('debe usar LF y terminar con salto de línea');
  const words = text.slice(0, -1).split('\n');
  if (words.length !== 65536) errors.push(`${words.length} entradas (se esperan 65.536)`);
  if (new Set(words).size !== words.length) errors.push('hay palabras repetidas');
  const bad = words.filter((w) => !/^[a-z]+$/.test(w));
  if (bad.length) errors.push(`${bad.length} entradas fuera de [a-z]+`);
  for (let i = 1; i < words.length; i++) {
    if (words[i - 1] >= words[i]) {
      errors.push(`no está ordenada (posición ${i})`);
      break;
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = verifyWordlist();
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`);
    process.exit(1);
  }
  console.log('OK: MTW-WORDLIST-V1 verificada (65.536 palabras, SHA-256 exacto)');
}
