// La clave R interna en secp256k1 ([F-KEY-01]): generación con el CSPRNG de WebCrypto (escalar 1 ≤ k < n, si no se
// reintenta), dirección Ethereum (keccak256 de la clave pública sin el prefijo 0x04, en EIP-55) y firma de un digest de
// 32 bytes con @noble/curves (RFC 6979, s bajo, v ∈ {27, 28}: el formato estricto que exigen el backend y el signer).
import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, keccak256, type Address } from 'viem';
import { bytesToHex, EncodingError, hexToBytes, type Hex } from './encoding.ts';

export type RandomBytes = (length: number) => Uint8Array;

export const randomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export class KeyError extends Error {
  override name = 'KeyError';
}

export function isValidPrivateKey(key: Uint8Array): boolean {
  return key.length === 32 && secp256k1.utils.isValidSecretKey(key);
}

/** Clave privada nueva (32 bytes); los candidatos fuera de rango se descartan y se borran. */
export function newPrivateKey(random: RandomBytes = randomBytes): Uint8Array {
  for (;;) {
    const candidate = random(32);
    if (isValidPrivateKey(candidate)) return candidate;
    candidate.fill(0);
  }
}

export function addressOfKey(key: Uint8Array): Address {
  if (!isValidPrivateKey(key)) throw new KeyError('clave privada fuera de rango');
  const publicKey = secp256k1.getPublicKey(key, false);
  return getAddress(`0x${keccak256(publicKey.subarray(1)).slice(-40)}`);
}

/** Firma ECDSA de un digest de 32 bytes: r ‖ s ‖ v (65 bytes), s en la mitad baja y v = 27 + recovery. */
export function signDigest(digest: Hex | Uint8Array, key: Uint8Array): Hex {
  let hash: Uint8Array;
  try {
    hash = typeof digest === 'string' ? hexToBytes(digest, 32) : digest;
  } catch (error) {
    if (error instanceof EncodingError) throw new KeyError('el digest a firmar tiene que ser de 32 bytes');
    throw error;
  }
  if (hash.length !== 32) throw new KeyError('el digest a firmar tiene que ser de 32 bytes');
  if (!isValidPrivateKey(key)) throw new KeyError('clave privada fuera de rango');
  const signature = secp256k1.sign(hash, key, { lowS: true });
  const out = new Uint8Array(65);
  out.set(signature.toBytes('compact'), 0);
  out[64] = 27 + signature.recovery;
  return bytesToHex(out);
}
