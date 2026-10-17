// Digests EIP-712 de la plataforma que verifica el signer [W-01] (implementación propia):
// - KeyAcceptance(string walletId,uint8 role,address newKey,bytes32 nonce) — dominio "MTW Wallet" v1 (WalletFactory);
// - CancelRotation(bytes32 proposalId,address safe) — dominio "MTW RotationTimelock" v1 (RotationTimelock).
import { concatBytes, type Hex, hexToBytes, utf8 } from '../crypto/bytes.ts';
import { keccak256, keccakHex, type Address } from '../crypto/keccak.ts';
import { wordAddress, wordUint } from './abi.ts';

const DOMAIN_TYPEHASH = keccakHex(
  utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);
export const KEY_ACCEPTANCE_TYPEHASH = keccakHex(
  utf8('KeyAcceptance(string walletId,uint8 role,address newKey,bytes32 nonce)'),
);
export const CANCEL_ROTATION_TYPEHASH = keccakHex(utf8('CancelRotation(bytes32 proposalId,address safe)'));

export function domainSeparator(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: Address,
): Uint8Array {
  return keccak256(
    concatBytes(
      hexToBytes(DOMAIN_TYPEHASH, 32),
      keccak256(utf8(name)),
      keccak256(utf8(version)),
      wordUint(chainId),
      wordAddress(verifyingContract),
    ),
  );
}

function typedDigest(domain: Uint8Array, structHash: Uint8Array): Uint8Array {
  return keccak256(concatBytes(Uint8Array.of(0x19, 0x01), domain, structHash));
}

export interface KeyAcceptance {
  walletId: string;
  role: number;
  newKey: Address;
  nonce: Hex;
}

export function keyAcceptanceDigest(chainId: number, walletFactory: Address, message: KeyAcceptance): Uint8Array {
  const struct = keccak256(
    concatBytes(
      hexToBytes(KEY_ACCEPTANCE_TYPEHASH, 32),
      keccak256(utf8(message.walletId)),
      wordUint(message.role),
      wordAddress(message.newKey),
      hexToBytes(message.nonce, 32),
    ),
  );
  return typedDigest(domainSeparator('MTW Wallet', '1', chainId, walletFactory), struct);
}

export function cancelRotationDigest(chainId: number, timelock: Address, proposalId: Hex, safe: Address): Uint8Array {
  const struct = keccak256(
    concatBytes(hexToBytes(CANCEL_ROTATION_TYPEHASH, 32), hexToBytes(proposalId, 32), wordAddress(safe)),
  );
  return typedDigest(domainSeparator('MTW RotationTimelock', '1', chainId, timelock), struct);
}
