// Codificación EIP-712 de SafeTx (Safe v1.5.0): dominio `{chainId, verifyingContract: safe}`. El backend recalcula el
// SafeTxHash desde los campos (nunca confía en el que manda un cliente) [B-Q-02 paso 3].
import { hashDomain, hashTypedData, keccak256, toBytes, type Address, type Hash, type Hex } from 'viem';

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
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

export const SAFE_DOMAIN_TYPEHASH = keccak256(toBytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
export const SAFE_TX_TYPEHASH = keccak256(
  toBytes(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
  ),
);

export function safeDomain(chainId: number, safe: Address) {
  return { chainId, verifyingContract: safe } as const;
}

export function safeDomainSeparator(chainId: number, safe: Address): Hash {
  return hashDomain({
    domain: { chainId: BigInt(chainId), verifyingContract: safe },
    types: {
      EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
}

/** Typed data completo (lo que firma U o R con eth_signTypedData_v4). */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: safeDomain(chainId, safe),
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: tx,
  };
}

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hash {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** SafeTx asistida (camino U+S / R+S): CALL y parámetros de gas/reembolso en cero ([C-GRD], [B-SIG-06]). */
export function isPlainCall(tx: SafeTx): boolean {
  const zero = '0x0000000000000000000000000000000000000000';
  return (
    tx.operation === 0 &&
    tx.safeTxGas === 0n &&
    tx.baseGas === 0n &&
    tx.gasPrice === 0n &&
    tx.gasToken.toLowerCase() === zero &&
    tx.refundReceiver.toLowerCase() === zero
  );
}
