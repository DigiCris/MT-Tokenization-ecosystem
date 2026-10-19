// Clave Ed25519 de release de la herramienta de salida soberana (propia, como la de cada app). Privada, en este orden:
// archivo `MTW_RELEASE_KEY_FILE` (PEM o DER PKCS#8), variable `SOVEREIGN_EXIT_RELEASE_SIGNING_KEY` (PKCS#8 DER en
// base64; en el pipeline de release, secreto del Environment) o, sólo en desarrollo local,
// `SOVEREIGN_EXIT_RELEASE_SIGNING_KEY_LOCAL` de wallet/.env (`pnpm secrets:local`). Pública: archivo `--public-key`,
// variable `SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY` (SPKI DER en base64), wallet/.env o config/release-keys/sovereign-exit.pub.
// Nunca se imprimen.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const WALLET_ROOT = resolve(import.meta.dirname, '../../..');

function dotenv(): Record<string, string> {
  const file = resolve(WALLET_ROOT, '.env');
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    values[match[1]] = (match[2] ?? '')
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function fromFile(path: string, kind: 'private' | 'public'): KeyObject {
  const bytes = readFileSync(path);
  const pem = bytes.toString('utf8').includes('-----BEGIN');
  if (kind === 'private')
    return pem ? createPrivateKey(bytes) : createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  return pem ? createPublicKey(bytes) : createPublicKey({ key: bytes, format: 'der', type: 'spki' });
}

function ed25519(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('la clave de release de la herramienta debe ser Ed25519');
  return key;
}

export function releasePrivateKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  if (env.MTW_RELEASE_KEY_FILE) return ed25519(fromFile(env.MTW_RELEASE_KEY_FILE, 'private'));
  const base64 = env.SOVEREIGN_EXIT_RELEASE_SIGNING_KEY || dotenv().SOVEREIGN_EXIT_RELEASE_SIGNING_KEY_LOCAL;
  if (!base64) {
    throw new Error(
      'falta la clave de release (MTW_RELEASE_KEY_FILE o SOVEREIGN_EXIT_RELEASE_SIGNING_KEY; local: pnpm secrets:local)',
    );
  }
  return ed25519(createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' }));
}

export function releasePublicKey(file?: string, env: NodeJS.ProcessEnv = process.env): KeyObject {
  if (file) return ed25519(fromFile(file, 'public'));
  const base64 = env.SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY || dotenv().SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY;
  if (base64) return ed25519(createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' }));
  const pinned = resolve(WALLET_ROOT, 'config/release-keys/sovereign-exit.pub');
  if (existsSync(pinned)) return ed25519(fromFile(pinned, 'public'));
  throw new Error(
    'falta la clave pública de release (--public-key, SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY o config/release-keys)',
  );
}
