// Keystore Ethereum V3 (Web3 Secret Storage) [B-SIG-08]: scrypt de @noble/hashes, AES-128-CTR de node:crypto y MAC
// keccak256(dk[16..32] ‖ ciphertext). Formato estándar, interoperable con geth, Foundry (`cast wallet`) y Web3Signer.
//
// Al descifrar se aceptan sólo keystores scrypt con parámetros acotados (evita que un archivo manipulado fuerce un
// consumo de memoria arbitrario) y se verifica el MAC antes de descifrar y la dirección después.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { scrypt } from '@noble/hashes/scrypt.js';
import { z } from 'zod';
import { concatBytes, wipe } from '../crypto/bytes.ts';
import { keccak256, type Address } from '../crypto/keccak.ts';
import { isValidPrivateKey, privateKeyToAddress } from '../crypto/secp256k1.ts';

/** Parámetros con los que el signer crea keystores (la contraseña derivada ya tiene 256 bits). */
export const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, dklen: 32 } as const;

const MAX_SCRYPT_N = 262_144;
const hexBytes = (min: number, max = min) =>
  z
    .string()
    .regex(/^[0-9a-f]+$/i)
    .refine((v) => v.length % 2 === 0 && v.length >= min * 2 && v.length <= max * 2);

export const KeystoreV3Schema = z.object({
  version: z.literal(3),
  id: z.string().min(1).max(64),
  address: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{40}$/)
    .optional(),
  crypto: z.object({
    cipher: z.literal('aes-128-ctr'),
    cipherparams: z.object({ iv: hexBytes(16) }),
    ciphertext: hexBytes(32),
    kdf: z.literal('scrypt'),
    kdfparams: z.object({
      dklen: z.literal(32),
      salt: hexBytes(16, 64),
      n: z
        .number()
        .int()
        .min(2)
        .max(MAX_SCRYPT_N)
        .refine((n) => (n & (n - 1)) === 0, 'n debe ser potencia de 2'),
      r: z.number().int().min(1).max(8),
      p: z.number().int().min(1).max(16),
    }),
    mac: hexBytes(32),
  }),
});
export type KeystoreV3 = z.infer<typeof KeystoreV3Schema>;

export type KeystoreProblem = 'FORMAT' | 'MAC' | 'ADDRESS' | 'KEY';

export class KeystoreError extends Error {
  override name = 'KeystoreError';
  readonly problem: KeystoreProblem;

  constructor(problem: KeystoreProblem) {
    super(`keystore inválido (${problem})`);
    this.problem = problem;
  }
}

function deriveKey(password: Uint8Array, salt: Uint8Array, params: { n: number; r: number; p: number }): Uint8Array {
  return scrypt(password, salt, { N: params.n, r: params.r, p: params.p, dkLen: 32, maxmem: 256 * 1024 * 1024 });
}

function macOf(derived: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return keccak256(concatBytes(derived.subarray(16, 32), ciphertext));
}

/** Cifra una clave privada secp256k1 en un keystore V3. `salt`, `iv` e `id` sólo se fijan en tests de vectores. */
export function encryptKeystore(
  privateKey: Uint8Array,
  password: Uint8Array,
  options: { salt?: Uint8Array; iv?: Uint8Array; id?: string; params?: { n: number; r: number; p: number } } = {},
): KeystoreV3 {
  if (!isValidPrivateKey(privateKey)) throw new KeystoreError('KEY');
  const params = options.params ?? SCRYPT_PARAMS;
  const salt = options.salt ?? Uint8Array.from(randomBytes(32));
  const iv = options.iv ?? Uint8Array.from(randomBytes(16));
  const derived = deriveKey(password, salt, params);
  try {
    const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
    const ciphertext = Uint8Array.from(Buffer.concat([cipher.update(privateKey), cipher.final()]));
    const address = privateKeyToAddress(privateKey);
    return {
      version: 3,
      id: options.id ?? randomUUID(),
      address: address.slice(2).toLowerCase(),
      crypto: {
        cipher: 'aes-128-ctr',
        cipherparams: { iv: Buffer.from(iv).toString('hex') },
        ciphertext: Buffer.from(ciphertext).toString('hex'),
        kdf: 'scrypt',
        kdfparams: { dklen: 32, salt: Buffer.from(salt).toString('hex'), n: params.n, r: params.r, p: params.p },
        mac: Buffer.from(macOf(derived, ciphertext)).toString('hex'),
      },
    };
  } finally {
    wipe(derived);
  }
}

/**
 * Descifra un keystore V3 y devuelve la clave privada (el llamador la sobrescribe al terminar). Si `expected` se
 * indica, la clave debe corresponder a esa dirección (y el campo `address`, si está, también).
 */
export function decryptKeystore(input: unknown, password: Uint8Array, expected?: Address): Uint8Array {
  const parsed = KeystoreV3Schema.safeParse(input);
  if (!parsed.success) throw new KeystoreError('FORMAT');
  const { crypto: c, address } = parsed.data;
  if (expected !== undefined && address !== undefined) {
    if (address.replace(/^0x/, '').toLowerCase() !== expected.slice(2).toLowerCase()) {
      throw new KeystoreError('ADDRESS');
    }
  }
  const salt = Buffer.from(c.kdfparams.salt, 'hex');
  const ciphertext = Uint8Array.from(Buffer.from(c.ciphertext, 'hex'));
  const derived = deriveKey(password, salt, c.kdfparams);
  try {
    const mac = Buffer.from(macOf(derived, ciphertext));
    if (!timingSafeEqual(mac, Buffer.from(c.mac, 'hex'))) throw new KeystoreError('MAC');
    const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'));
    const key = Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    if (!isValidPrivateKey(key)) {
      wipe(key);
      throw new KeystoreError('KEY');
    }
    if (expected !== undefined && privateKeyToAddress(key).toLowerCase() !== expected.toLowerCase()) {
      wipe(key);
      throw new KeystoreError('ADDRESS');
    }
    return key;
  } finally {
    wipe(derived);
  }
}
