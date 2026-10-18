// Derivación de claves ([F-KEY-03]): Root = Argon2id(password, salt de 16 bytes, m, t=3, p=4, 32 bytes) en el worker
// dedicado; de Root, con HKDF-SHA256 de WebCrypto (salt "mtw-hkdf-v1"): K_U ("U-encryption-v1") como CryptoKey AES-GCM
// no exportable y AuthSecret_U ("U-auth-v1"), la entrada de OPAQUE. Root nunca sale de esta función: se borra apenas se
// importa como clave HKDF no exportable.
import { ARGON2_BASELINE, type Argon2Params } from '../workers/argon2-protocol.ts';
import { ownBuffer, utf8, zeroize } from './bytes.ts';

export const HKDF_SALT = 'mtw-hkdf-v1';
export type KeyRole = 'U' | 'R';

/** Parámetros del sobre ([F-KEY-04]); para U existe la opción de 128 MiB en desktop. */
export interface KdfParams {
  alg: 'argon2id';
  version: 19;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  /** base64url de 16 bytes. */
  salt: string;
}

/** Argon2id(password, salt) → Root (32 bytes); en el navegador, el worker; en tests, la función directa. */
export type Argon2 = (input: Argon2Params & { password: Uint8Array; salt: Uint8Array }) => Promise<Uint8Array>;

export function defaultKdfParams(salt: string, memoryKiB: number = ARGON2_BASELINE.memoryKiB): KdfParams {
  return {
    alg: 'argon2id',
    version: 19,
    memoryKiB,
    iterations: ARGON2_BASELINE.iterations,
    parallelism: ARGON2_BASELINE.parallelism,
    salt,
  };
}

/** Las claves derivadas de una Password: Root ya fue borrado. */
export interface DerivedKeys {
  /** K_U o K_R: AES-256-GCM, no exportable. */
  encryptionKey: CryptoKey;
  /** AuthSecret_U (sólo para U; entrada de OPAQUE). El llamador lo borra al terminar. */
  authSecret: Uint8Array | null;
}

async function hkdfKey(root: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ownBuffer(root), 'HKDF', false, ['deriveKey', 'deriveBits']);
}

const hkdfParams = (info: string): HkdfParams => ({
  name: 'HKDF',
  hash: 'SHA-256',
  salt: ownBuffer(utf8(HKDF_SALT)),
  info: ownBuffer(utf8(info)),
});

/** HKDF-SHA256(Root, "mtw-hkdf-v1", info, 32) en bytes (AuthSecret_U y vectores). */
export async function hkdfBytes(root: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await hkdfKey(root);
  return new Uint8Array(await crypto.subtle.deriveBits(hkdfParams(info), key, 256));
}

export async function deriveKeys(
  password: string,
  role: KeyRole,
  params: KdfParams,
  saltBytes: Uint8Array,
  argon2: Argon2,
): Promise<DerivedKeys> {
  const passwordBytes = utf8(password);
  const root = await argon2({
    password: passwordBytes,
    salt: saltBytes,
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    outputLength: 32,
  });
  try {
    const base = await hkdfKey(root);
    const encryptionKey = await crypto.subtle.deriveKey(
      hkdfParams(`${role}-encryption-v1`),
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const authSecret =
      role === 'U' ? new Uint8Array(await crypto.subtle.deriveBits(hkdfParams('U-auth-v1'), base, 256)) : null;
    return { encryptionKey, authSecret };
  } finally {
    zeroize(root, passwordBytes);
  }
}
