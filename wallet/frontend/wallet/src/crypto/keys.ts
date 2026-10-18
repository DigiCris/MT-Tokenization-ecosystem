// Generación y validación de U ([F-KEY-01]): 32 bytes de `crypto.getRandomValues`, escalar válido de secp256k1
// (1 ≤ k < n; si no, se descarta y se vuelve a sortear) y dirección derivada con viem desde la clave pública sin
// comprimir. Nunca Math.random.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getAddress, type Address } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { randomBytes, toHex, zeroize } from './bytes.ts';

export function isValidPrivateKey(key: Uint8Array): boolean {
  return key.length === 32 && secp256k1.utils.isValidSecretKey(key);
}

/** Clave privada nueva; `random` sólo se inyecta en tests (para forzar escalares inválidos). */
export function generatePrivateKey(random: (length: number) => Uint8Array = randomBytes): Uint8Array {
  for (;;) {
    const key = random(32);
    if (isValidPrivateKey(key)) return key;
    zeroize(key);
  }
}

export function addressOf(key: Uint8Array): Address {
  if (!isValidPrivateKey(key)) throw new TypeError('clave privada inválida');
  const publicKey = secp256k1.getPublicKey(key, false);
  return getAddress(publicKeyToAddress(toHex(publicKey)));
}
