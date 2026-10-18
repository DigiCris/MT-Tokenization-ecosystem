// Claves Ed25519 de release de la app Wallet ([F-SEC-06], P16.T06; distintas de las de Recovery, P20.T01). Privada,
// en este orden: archivo `MTW_RELEASE_KEY_FILE` (PEM, o DER PKCS#8), variable `WALLET_RELEASE_SIGNING_KEY` (PKCS#8 DER
// en base64; staging/producción: secreto del Environment del pipeline, P20/P26) o, sólo en desarrollo local,
// `WALLET_RELEASE_SIGNING_KEY_LOCAL` de wallet/.env (`pnpm secrets:local`). Pública: archivo `--public-key`, variable
// `WALLET_RELEASE_PUBLIC_KEY` (SPKI DER en base64), wallet/.env o config/release-keys/wallet.pub (P20). Nunca se
// imprimen.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WALLET_ROOT } from './config.ts';
import { readEnvFile } from './env-file.ts';

type Source = Record<string, string | undefined>;

function fromFile(path: string, kind: 'private' | 'public'): KeyObject {
  const bytes = readFileSync(path);
  const pem = bytes.toString('utf8').includes('-----BEGIN');
  const key = pem
    ? kind === 'private'
      ? createPrivateKey(bytes)
      : createPublicKey(bytes)
    : kind === 'private'
      ? createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' })
      : createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  return key;
}

function ed25519(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${what} debe ser Ed25519`);
  return key;
}

function localEnv(): Record<string, string> {
  return readEnvFile(resolve(WALLET_ROOT, '.env')) ?? {};
}

export function releasePrivateKey(env: Source = process.env): KeyObject {
  if (env.MTW_RELEASE_KEY_FILE) return ed25519(fromFile(env.MTW_RELEASE_KEY_FILE, 'private'), 'la clave de release');
  const base64 = env.WALLET_RELEASE_SIGNING_KEY || localEnv().WALLET_RELEASE_SIGNING_KEY_LOCAL;
  if (!base64) {
    throw new Error(
      'falta la clave de release de wallet (MTW_RELEASE_KEY_FILE o WALLET_RELEASE_SIGNING_KEY; local: pnpm secrets:local)',
    );
  }
  return ed25519(
    createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' }),
    'la clave de release',
  );
}

export function releasePublicKey(file?: string, env: Source = process.env): KeyObject {
  if (file) return ed25519(fromFile(file, 'public'), 'la clave pública de release');
  const base64 = env.WALLET_RELEASE_PUBLIC_KEY || localEnv().WALLET_RELEASE_PUBLIC_KEY;
  if (base64)
    return ed25519(
      createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' }),
      'la clave pública de release',
    );
  const pinned = resolve(WALLET_ROOT, 'config/release-keys/wallet.pub');
  if (existsSync(pinned)) return ed25519(fromFile(pinned, 'public'), 'la clave pública de release');
  throw new Error(
    'falta la clave pública de release de wallet (--public-key, WALLET_RELEASE_PUBLIC_KEY o config/release-keys/wallet.pub)',
  );
}
