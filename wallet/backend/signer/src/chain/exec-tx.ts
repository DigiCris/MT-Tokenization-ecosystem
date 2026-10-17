// Transacción que firma S [B-SIG-02]/[B-SIG-05]: `execTransaction` de la Safe con las dos firmas del threshold
// (ordenadas por dirección del owner, como exige `checkNSignatures`) y la tx EIP-1559 que la lleva, firmada con la
// misma clave S. El signer calcula los digests; el provider sólo firma digests de 32 bytes.
import {
  encodeFunctionData,
  keccak256 as viemKeccak,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { concatBytes, type Hex, hexToBytes } from '../crypto/bytes.ts';
import type { Address } from '../crypto/keccak.ts';
import type { EthSignature } from '../crypto/secp256k1.ts';
import { iSafeAbi } from './abis/index.ts';
import type { SafeTx } from './safe-tx.ts';

export interface OwnerSignature {
  signer: Address;
  signature: Hex;
}

/** Blob `signatures` de Safe: firmas de 65 bytes concatenadas en orden ascendente de dirección del firmante. */
export function packSignatures(signatures: readonly OwnerSignature[]): Hex {
  const sorted = [...signatures].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.signer.toLowerCase() === sorted[i - 1]?.signer.toLowerCase()) throw new Error('firmante repetido');
  }
  return `0x${Buffer.from(concatBytes(...sorted.map((s) => hexToBytes(s.signature, 65)))).toString('hex')}`;
}

export function execTransactionData(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
  });
}

export interface Eip1559Params {
  chainId: number;
  nonce: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

function serializable(p: Eip1559Params): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: p.chainId,
    nonce: Number(p.nonce),
    to: p.to,
    value: p.value,
    data: p.data,
    gas: p.gasLimit,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    accessList: [],
  };
}

/** Hash de firma de la tx EIP-1559 (keccak de la serialización sin firma). */
export function eip1559SigningHash(p: Eip1559Params): Uint8Array {
  if (p.nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('nonce de cuenta fuera de rango');
  return hexToBytes(viemKeccak(serializeTransaction(serializable(p))), 32);
}

/** Serialización firmada y hash de la tx. */
export function signedEip1559(p: Eip1559Params, signature: EthSignature): { raw: Hex; hash: Hex } {
  const raw = serializeTransaction(serializable(p), {
    r: signature.r,
    s: signature.s,
    yParity: signature.yParity,
  });
  return { raw, hash: viemKeccak(raw) };
}
