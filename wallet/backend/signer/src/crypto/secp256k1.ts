// secp256k1 del signer (@noble/curves): generación de claves, firma de digests de 32 bytes (RFC 6979 determinística,
// low-s) con `v` de Ethereum (27/28) y recuperación estricta de firmas ECDSA de 65 bytes.
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToBigInt, bytesToHex, concatBytes, type Hex, hexToBytes, wipe } from './bytes.ts';
import { checksumAddress, keccak256, type Address } from './keccak.ts';

const N = secp256k1.Point.CURVE().n;
const HALF_N = N >> 1n;

export interface EthSignature {
  r: Hex;
  s: Hex;
  /** 27 o 28. */
  v: 27 | 28;
  /** 0 o 1 (paridad de y, para transacciones EIP-1559). */
  yParity: 0 | 1;
  /** r ‖ s ‖ v (65 bytes), el formato de Safe y de `ecrecover`. */
  bytes: Hex;
}

export function isValidPrivateKey(key: Uint8Array): boolean {
  if (key.length !== 32) return false;
  const k = bytesToBigInt(key);
  return k > 0n && k < N;
}

/** Escalar válido generado con el CSPRNG del sistema (muestreo por rechazo). */
export function generatePrivateKey(): Uint8Array {
  for (;;) {
    const candidate = Uint8Array.from(randomBytes(32));
    if (isValidPrivateKey(candidate)) return candidate;
    wipe(candidate);
  }
}

export function publicKeyToAddress(uncompressed: Uint8Array): Address {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) throw new TypeError('clave pública inválida');
  return checksumAddress(bytesToHex(keccak256(uncompressed.subarray(1)).subarray(12)));
}

export function privateKeyToAddress(key: Uint8Array): Address {
  if (!isValidPrivateKey(key)) throw new TypeError('clave privada inválida');
  const publicKey = secp256k1.getPublicKey(key, false);
  try {
    return publicKeyToAddress(publicKey);
  } finally {
    wipe(publicKey);
  }
}

/** Firma un digest de 32 bytes tal cual (sin prehash), low-s y k determinístico (RFC 6979). */
export function signDigest(digest: Uint8Array, key: Uint8Array): EthSignature {
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
  const r = recovered.subarray(1, 33);
  const s = recovered.subarray(33, 65);
  const v = (27 + recovery) as 27 | 28;
  return {
    r: bytesToHex(r),
    s: bytesToHex(s),
    v,
    yParity: recovery,
    bytes: bytesToHex(concatBytes(r, s, Uint8Array.of(v))),
  };
}

export type StrictSignatureProblem = 'LENGTH' | 'V' | 'HIGH_S' | 'RANGE' | 'UNRECOVERABLE';

export class StrictSignatureError extends Error {
  override name = 'StrictSignatureError';
  readonly problem: StrictSignatureProblem;

  constructor(problem: StrictSignatureProblem) {
    super(`firma ECDSA inválida (${problem})`);
    this.problem = problem;
  }
}

/**
 * Recupera la dirección de una firma ECDSA estricta: exactamente 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}`, `0 < r, s < n`
 * y `s ≤ n/2` (low-s). Cualquier otra forma (incluidas las de contrato, approved hash o eth_sign de Safe) se rechaza.
 */
export function recoverStrict(digest: Uint8Array, signature: string): Address {
  if (digest.length !== 32) throw new TypeError('el digest debe tener 32 bytes');
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(signature, 65);
  } catch {
    throw new StrictSignatureError('LENGTH');
  }
  const v = bytes[64];
  if (v !== 27 && v !== 28) throw new StrictSignatureError('V');
  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new StrictSignatureError('RANGE');
  if (s > HALF_N) throw new StrictSignatureError('HIGH_S');
  try {
    const recovered = concatBytes(Uint8Array.of(v - 27), bytes.subarray(0, 64));
    const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    return publicKeyToAddress(secp256k1.Point.fromBytes(publicKey).toBytes(false));
  } catch {
    throw new StrictSignatureError('UNRECOVERABLE');
  }
}
