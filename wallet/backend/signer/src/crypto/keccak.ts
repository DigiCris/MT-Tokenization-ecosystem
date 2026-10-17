// keccak256 y direcciones EIP-55 (implementación propia del signer sobre @noble/hashes).
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, type Hex, utf8 } from './bytes.ts';

export type Address = `0x${string}`;

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccakHex(data: Uint8Array): Hex {
  return bytesToHex(keccak_256(data));
}

/** Selector de 4 bytes de una firma de función (`transfer(address,uint256)`). */
export function selectorOf(signature: string): Hex {
  return bytesToHex(keccak_256(utf8(signature)).subarray(0, 4));
}

export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Dirección con checksum EIP-55; rechaza un input con mayúsculas mezcladas cuyo checksum no coincide. */
export function checksumAddress(value: string): Address {
  if (!isAddress(value)) throw new TypeError('dirección inválida');
  const lower = value.slice(2).toLowerCase();
  const hash = Buffer.from(keccak_256(utf8(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const c = lower[i] ?? '';
    out += Number.parseInt(hash[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c;
  }
  const body = value.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && out !== value) throw new TypeError('checksum EIP-55 inválido');
  return out as Address;
}

export function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export function addressToBytes(address: string): Uint8Array {
  if (!isAddress(address)) throw new TypeError('dirección inválida');
  return hexToBytes(address.toLowerCase());
}
