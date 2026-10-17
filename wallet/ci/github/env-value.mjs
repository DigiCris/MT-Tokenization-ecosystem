#!/usr/bin/env node
// Escribe en stdout (sin salto de línea) el valor de una variable de wallet/.env, para pasarlo por pipe a
// `gh secret set` sin que aparezca en la línea de comandos ni en logs. Sale con 3 si falta.
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../scripts/preflight.d/lib/env.mjs';

const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = process.argv[2];
const env = readEnvFile(process.env.MTW_ENV_FILE ?? join(WALLET_ROOT, '.env'));
const value = env[name] ?? '';
if (!value) {
  console.error(`falta ${name} en wallet/.env`);
  process.exit(3);
}
process.stdout.write(value);
