// SafeTx de Safe v1.5.0 (EIP-712 con el dominio {chainId, verifyingContract: Safe}) para la salida soberana: siempre
// CALL, sin reembolso de gas; U y R firman el hash que calcula la herramienta y las firmas van ordenadas por firmante
// (ascendente) en la calldata de execTransaction, como las verifica la Safe.
import {
  concat,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { sign } from 'viem/accounts';
import { bytesToHex } from '../crypto/encoding.ts';

export const SAFE_ABI = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function setGuard(address guard)',
  'function setModuleGuard(address moduleGuard)',
]);

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function call(to: Address, data: Hex, nonce: bigint, value = 0n): SafeTx {
  return {
    to: getAddress(to),
    value,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };
}

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  });
}

export interface OwnerSignature {
  signer: Address;
  signature: Hex;
}

/** Firma el hash con una clave (32 bytes): firma ECDSA con v = 27/28, como la espera la Safe. */
export async function signHash(hash: Hex, key: Uint8Array, signer: Address): Promise<OwnerSignature> {
  const signature = await sign({ hash, privateKey: bytesToHex(key), to: 'hex' });
  return { signer: getAddress(signer), signature };
}

/** Calldata de execTransaction con las firmas ordenadas por firmante (ascendente). */
export function execTransactionData(tx: SafeTx, signatures: readonly OwnerSignature[]): Hex {
  const sorted = [...signatures].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  return encodeFunctionData({
    abi: SAFE_ABI,
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
      concat(sorted.map((s) => s.signature)),
    ],
  });
}
