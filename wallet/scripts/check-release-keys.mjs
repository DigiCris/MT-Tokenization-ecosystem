#!/usr/bin/env node
// Claves de release de Wallet y Recovery (P20.T01, ADR-023), sin dependencias:
//  - las públicas fijadas existen y son Ed25519 (SPKI PEM): producción en config/release-keys/{wallet,recovery}.pub y
//    staging en config/release-keys/staging/{wallet,recovery}.pub;
//  - Wallet y Recovery usan claves distintas en cada entorno, y staging no repite ninguna de producción;
//  - ninguna clave privada en archivos versionados (PEM de clave privada ni `*_RELEASE_SIGNING_KEY*` con valor);
//  - las privadas no existen en el backend: ningún archivo de backend/ ni de infra/ menciona una clave de firma de
//    release (el monitor sólo recibe las públicas);
//  - las claves de desarrollo de wallet/.env (si existe) no son ninguna de las fijadas.
// Imprime "RELEASE KEYS OK" o la lista de problemas (código 1). Nunca imprime claves.
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const PINNED = {
  production: { WALLET: 'config/release-keys/wallet.pub', RECOVERY: 'config/release-keys/recovery.pub' },
  staging: { WALLET: 'config/release-keys/staging/wallet.pub', RECOVERY: 'config/release-keys/staging/recovery.pub' },
};
const problems = [];
const fingerprints = new Map();

for (const [environment, apps] of Object.entries(PINNED)) {
  for (const [app, path] of Object.entries(apps)) {
    const file = join(ROOT, path);
    if (!existsSync(file)) {
      problems.push(`${path}: falta la clave pública de release de ${app} (${environment})`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(text)) {
      problems.push(`${path}: no es una clave pública PEM (SPKI)`);
      continue;
    }
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== 'ed25519') {
      problems.push(`${path}: no es Ed25519`);
      continue;
    }
    const der = key.export({ format: 'der', type: 'spki' }).toString('base64');
    if (fingerprints.has(der)) problems.push(`${path}: repite la clave de ${fingerprints.get(der)}`);
    fingerprints.set(der, path);
  }
}

// Archivos versionados del repositorio (los de wallet/ y los de CI en la raíz).
const tracked = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', 'wallet', '.github'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && !f.includes('/node_modules/') && !f.endsWith('pnpm-lock.yaml'));
const PRIVATE_PEM = /-----BEGIN (?:ENCRYPTED |EC |RSA |OPENSSH )?PRIVATE KEY-----/;
const SIGNING_VALUE = /\b[A-Z_]*RELEASE_SIGNING_KEY[A-Z_]*\s*[=:]\s*["']?[A-Za-z0-9+/]{40,}/;
const BACKEND = /^wallet\/(backend|infra)\//;
// Este script y los tests que arman fixtures de "clave privada" en runtime mencionan los patrones, no claves.
const SELF = new Set(['wallet/scripts/check-release-keys.mjs']);
for (const file of tracked) {
  if (SELF.has(file)) continue;
  let text;
  try {
    text = readFileSync(join(REPO, file), 'utf8');
  } catch {
    continue;
  }
  if (PRIVATE_PEM.test(text)) problems.push(`${file}: contiene una clave privada en PEM`);
  if (SIGNING_VALUE.test(text)) problems.push(`${file}: asigna un valor a una clave de firma de release`);
  if (BACKEND.test(file) && /RELEASE_SIGNING_KEY|release-(wallet|recovery)\.pem/.test(text)) {
    problems.push(`${file}: el backend no debe recibir claves privadas de release`);
  }
}

// Las claves locales (pnpm secrets:local) nunca son las fijadas para staging o producción.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^(WALLET|RECOVERY)_RELEASE_PUBLIC_KEY=(\S+)/.exec(line);
    if (match && fingerprints.has(match[2])) {
      problems.push(`wallet/.env: ${match[1]}_RELEASE_PUBLIC_KEY local es una clave fijada (${fingerprints.get(match[2])})`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FALLA: ${problem}`);
  process.exit(1);
}
console.log(`RELEASE KEYS OK (${String(fingerprints.size)} públicas fijadas, ${String(tracked.length)} archivos revisados)`);
