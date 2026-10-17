// Contraseña de cada keystore [B-SIG-08]: hex(HKDF-SHA256(credencial del shard, salt="mtw-signer-keystore-v1",
// info=dirección)), con la dirección en minúsculas y con prefijo 0x (UTF-8). La contraseña ya tiene 256 bits: por eso
// el scrypt del keystore usa parámetros livianos (N=2^14, r=8, p=1).
import { readFileSync, statSync } from 'node:fs';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8, wipe } from '../crypto/bytes.ts';
import { isAddress, type Address } from '../crypto/keccak.ts';
import { Secret } from '../config/secret.ts';

export const KEYSTORE_PASSWORD_SALT = 'mtw-signer-keystore-v1';
export const CREDENTIAL_BYTES = 32;

/** Contraseña del keystore de `address` como bytes UTF-8 del hex (64 caracteres). */
export function deriveKeystorePassword(credential: Secret<Uint8Array>, address: Address): Uint8Array {
  if (!isAddress(address)) throw new TypeError('dirección inválida');
  const okm = hkdf(sha256, credential.reveal(), utf8(KEYSTORE_PASSWORD_SALT), utf8(address.toLowerCase()), 32);
  try {
    return utf8(Buffer.from(okm).toString('hex'));
  } finally {
    wipe(okm);
  }
}

export class CredentialError extends Error {
  override name = 'CredentialError';
}

/**
 * Credencial de desbloqueo del shard: 32 bytes en hex (64 caracteres, con o sin salto de línea final) en un archivo
 * que sólo puede leer su dueño. Nunca vive en el directorio de keystores.
 */
export function readCredentialFile(path: string, options: { keystoreDir?: string } = {}): Secret<Uint8Array> {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new CredentialError('no se puede leer el archivo de la credencial de desbloqueo');
  }
  if (!stats.isFile()) throw new CredentialError('la credencial de desbloqueo no es un archivo');
  if ((stats.mode & 0o077) !== 0) {
    throw new CredentialError('la credencial de desbloqueo es accesible por otros usuarios (se exige 0600 o 0400)');
  }
  if (options.keystoreDir !== undefined && isInside(path, options.keystoreDir)) {
    throw new CredentialError('la credencial de desbloqueo no puede estar dentro del directorio de keystores');
  }
  const text = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CredentialError('la credencial de desbloqueo debe ser 32 bytes en hex');
  return new Secret(Uint8Array.from(Buffer.from(text, 'hex')));
}

function isInside(file: string, dir: string): boolean {
  const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`;
  return file.startsWith(normalizedDir);
}
