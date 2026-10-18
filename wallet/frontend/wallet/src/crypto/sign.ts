// Firmas de U ([F-KEY-05]): el hash EIP-712 lo calcula viem y la firma es secp256k1 de @noble/curves (RFC 6979
// determinística, low-s), 65 bytes r ‖ s ‖ v con v ∈ {27, 28}. U se descifra sólo para cada firma y el Uint8Array se
// sobrescribe con ceros al terminar (best-effort).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hashTypedData, type TypedData, type TypedDataDefinition } from 'viem';
import { fromHex, toHex, zeroize, type Hex } from './bytes.ts';
import { openEnvelope, type KeyEnvelope } from './envelope.ts';
import { isValidPrivateKey } from './keys.ts';

export function signDigest(digest: Uint8Array, key: Uint8Array): Hex {
  if (digest.length !== 32) throw new TypeError('el digest debe tener 32 bytes');
  if (!isValidPrivateKey(key)) throw new TypeError('clave privada inválida');
  const recovered = secp256k1.sign(digest, key, {
    prehash: false,
    lowS: true,
    format: 'recovered',
    extraEntropy: false,
  });
  const recovery = recovered[0];
  if (recovery !== 0 && recovery !== 1) throw new Error('bit de recuperación inesperado');
  const signature = new Uint8Array(65);
  signature.set(recovered.subarray(1, 65));
  signature[64] = 27 + recovery;
  return toHex(signature);
}

export function signTypedDataWithKey<
  const T extends TypedData | Record<string, unknown>,
  P extends keyof T | 'EIP712Domain',
>(key: Uint8Array, typedData: TypedDataDefinition<T, P>): Hex {
  return signDigest(fromHex(hashTypedData(typedData)), key);
}

/** Descifra U con K solamente durante `task` y la borra al terminar, aunque `task` falle. */
export async function withKey<T>(
  envelope: KeyEnvelope,
  encryptionKey: CryptoKey,
  task: (key: Uint8Array) => T | Promise<T>,
) {
  const key = await openEnvelope(envelope, encryptionKey);
  try {
    return await task(key);
  } finally {
    zeroize(key);
  }
}
