// Firmas ECDSA de owners (U o R) sobre SafeTxHash y typed data de plataforma [B-Q-02 paso 4]: validación estricta
// antes de recuperar el firmante — exactamente 65 bytes (r ‖ s ‖ v), s en la mitad baja de la curva (sin
// maleabilidad) y v ∈ {27, 28}. Se rechazan las variantes de Safe que el Guard excluye del camino asistido
// (v = 0 contrato/EIP-1271, v = 1 hash aprobado, v > 30 eth_sign).
import { recoverAddress, type Address, type Hash, type Hex } from 'viem';

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

export type SignatureProblem = 'LENGTH' | 'V_NOT_27_28' | 'HIGH_S' | 'ZERO_R_OR_S' | 'R_OUT_OF_RANGE';

export class InvalidSignatureError extends Error {
  override name = 'InvalidSignatureError';
  readonly reason: SignatureProblem;

  constructor(reason: SignatureProblem) {
    super(`firma inválida (${reason})`);
    this.reason = reason;
  }
}

export interface StrictSignature {
  r: bigint;
  s: bigint;
  v: 27 | 28;
  hex: Hex;
}

export function parseStrictSignature(signature: Hex): StrictSignature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new InvalidSignatureError('LENGTH');
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new InvalidSignatureError('V_NOT_27_28');
  if (r === 0n || s === 0n) throw new InvalidSignatureError('ZERO_R_OR_S');
  if (r >= SECP256K1_N) throw new InvalidSignatureError('R_OUT_OF_RANGE');
  if (s > HALF_N) throw new InvalidSignatureError('HIGH_S');
  return { r, s, v, hex: signature.toLowerCase() as Hex };
}

/** Firmante de un digest EIP-712 (SafeTxHash o typed data de plataforma) con validación estricta. */
export async function recoverStrictSigner(digest: Hash, signature: Hex): Promise<Address> {
  const parsed = parseStrictSignature(signature);
  return recoverAddress({ hash: digest, signature: parsed.hex });
}

/** Separa el blob de firmas concatenadas de Safe en firmas de 65 bytes. */
export function splitSignatures(signatures: Hex): Hex[] {
  const body = signatures.slice(2);
  if (body.length % 130 !== 0) throw new InvalidSignatureError('LENGTH');
  const out: Hex[] = [];
  for (let i = 0; i < body.length; i += 130) out.push(`0x${body.slice(i, i + 130)}`);
  return out;
}
