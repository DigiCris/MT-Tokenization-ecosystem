// Derivación de AuthSecret_U del cliente ([F-KEY-03], vectores en contracts/test/vectors/wire/envelope.json):
//   Root = Argon2id(Password U, salt, m, t, p, 32);  AuthSecret_U = HKDF-SHA256(Root, "mtw-hkdf-v1", "U-auth-v1", 32)
// La entrada OPAQUE es hex(AuthSecret_U) en minúsculas, sin prefijo. En producción la calcula sólo el navegador; el
// backend la usa en `dev:session` (local) y en los tests de vectores. La Password U nunca sale del cliente.
import { argon2Sync, hkdfSync } from 'node:crypto';

export interface KdfParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  /** base64url, 16 bytes. */
  salt: string;
}

/** Parámetros por defecto de [F-KEY-03] (los mismos del vector). */
export const DEFAULT_KDF = { alg: 'argon2id', version: 19, memoryKiB: 65536, iterations: 3, parallelism: 4 } as const;

export function deriveAuthSecret(passwordU: string, kdf: KdfParams): Buffer {
  const root = argon2Sync('argon2id', {
    message: Buffer.from(passwordU, 'utf8'),
    nonce: Buffer.from(kdf.salt, 'base64url'),
    parallelism: kdf.parallelism,
    tagLength: 32,
    memory: kdf.memoryKiB,
    passes: kdf.iterations,
  });
  return Buffer.from(
    hkdfSync('sha256', root, Buffer.from('mtw-hkdf-v1', 'utf8'), Buffer.from('U-auth-v1', 'utf8'), 32),
  );
}

/** Entrada OPAQUE ([B-PSES-02]): hex de AuthSecret_U. */
export function opaqueInput(authSecret: Buffer): string {
  return authSecret.toString('hex');
}
