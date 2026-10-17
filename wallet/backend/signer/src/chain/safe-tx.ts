// SafeTx de Safe 1.5.0 y su hash EIP-712 (dominio estándar de Safe `{chainId, verifyingContract: safe}`), calculado
// por el signer desde los campos (nunca aceptado del backend). Verificado contra contracts/test/vectors/safe-tx.json.
import { concatBytes, type Hex, hexToBytes, uint256ToBytes, utf8 } from '../crypto/bytes.ts';
import { keccak256, keccakHex, type Address } from '../crypto/keccak.ts';
import { wordAddress, wordUint } from './abi.ts';

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export const DOMAIN_TYPEHASH = keccakHex(utf8('EIP712Domain(uint256 chainId,address verifyingContract)'));
export const SAFE_TX_TYPEHASH = keccakHex(
  utf8(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
  ),
);

export function safeDomainSeparator(chainId: number, safe: Address): Uint8Array {
  return keccak256(concatBytes(hexToBytes(DOMAIN_TYPEHASH, 32), wordUint(chainId), wordAddress(safe)));
}

export function safeTxStructHash(tx: SafeTx): Uint8Array {
  return keccak256(
    concatBytes(
      hexToBytes(SAFE_TX_TYPEHASH, 32),
      wordAddress(tx.to),
      uint256ToBytes(tx.value),
      keccak256(hexToBytes(tx.data)),
      wordUint(tx.operation),
      uint256ToBytes(tx.safeTxGas),
      uint256ToBytes(tx.baseGas),
      uint256ToBytes(tx.gasPrice),
      wordAddress(tx.gasToken),
      wordAddress(tx.refundReceiver),
      uint256ToBytes(tx.nonce),
    ),
  );
}

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Uint8Array {
  return keccak256(concatBytes(Uint8Array.of(0x19, 0x01), safeDomainSeparator(chainId, safe), safeTxStructHash(tx)));
}
