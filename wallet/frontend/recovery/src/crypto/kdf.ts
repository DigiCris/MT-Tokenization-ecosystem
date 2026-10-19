// Derivación de K_R ([F-KEY-03]): Root_R = Argon2id(Password R, salt de 16 bytes, 64 MiB, t=3, p=4, 32 bytes) en el
// worker de la app (@noble/hashes; Recovery no habilita WASM, ADR-013) y K_R = HKDF-SHA256(Root_R, salt="mtw-hkdf-v1",
// info="R-encryption-v1", 32) con WebCrypto, importada como clave AES-GCM no exportable ([F-KEY-05]). Root_R se borra
// apenas se usa.
import { ARGON2_BASELINE, validateArgon2, type Argon2Params } from '../workers/argon2-protocol.ts';
import { toBufferSource, utf8, wipe } from './encoding.ts';

export const HKDF_SALT = 'mtw-hkdf-v1';
export const R_ENCRYPTION_INFO = 'R-encryption-v1';

/** Argon2id inyectable: el worker en el navegador; en los tests, la misma función del worker en el hilo principal. */
export type Argon2 = (input: Argon2Params & { password: Uint8Array; salt: Uint8Array }) => Promise<Uint8Array>;

export type KdfParams = Pick<Argon2Params, 'memoryKiB' | 'iterations' | 'parallelism'>;

/** R siempre con el baseline de V9: la recuperación puede ocurrir en cualquier dispositivo. */
export const R_KDF: KdfParams = {
  memoryKiB: ARGON2_BASELINE.memoryKiB,
  iterations: ARGON2_BASELINE.iterations,
  parallelism: ARGON2_BASELINE.parallelism,
};

export async function deriveRoot(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
  argon2: Argon2,
): Promise<Uint8Array> {
  const full = { ...params, outputLength: 32 };
  validateArgon2(full, salt);
  return argon2({ ...full, password: utf8(password), salt });
}

async function hkdfKey(root: Uint8Array): Promise<CryptoKey> {
  const source = toBufferSource(root);
  try {
    return await crypto.subtle.importKey('raw', source, 'HKDF', false, ['deriveKey', 'deriveBits']);
  } finally {
    wipe(source);
  }
}

function hkdfParams(): HkdfParams {
  return {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: toBufferSource(utf8(HKDF_SALT)),
    info: toBufferSource(utf8(R_ENCRYPTION_INFO)),
  };
}

/** K_R como CryptoKey AES-256-GCM no exportable; borra Root_R. */
export async function encryptionKeyFromRoot(root: Uint8Array): Promise<CryptoKey> {
  try {
    const base = await hkdfKey(root);
    return await crypto.subtle.deriveKey(hkdfParams(), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  } finally {
    wipe(root);
  }
}

/** K_R en bytes, sólo para comparar con los vectores (la app nunca la exporta). */
export async function encryptionKeyBytesForVectors(root: Uint8Array): Promise<Uint8Array> {
  const base = await hkdfKey(root);
  return new Uint8Array(await crypto.subtle.deriveBits(hkdfParams(), base, 256));
}
