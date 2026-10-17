// Conversión entre los hex `0x…` de la API/viem y los bytea de PostgreSQL (direcciones de 20 bytes, hashes de 32).
import { getAddress, isAddress, type Address, type Hex } from 'viem';

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

export function hexToBuffer(value: string, expectedLength?: number): Buffer {
  if (!HEX.test(value)) throw new TypeError('hex inválido');
  const buf = Buffer.from(value.slice(2), 'hex');
  if (expectedLength !== undefined && buf.length !== expectedLength) {
    throw new TypeError(`se esperaban ${expectedLength} bytes y llegaron ${buf.length}`);
  }
  return buf;
}

export function bufferToHex(value: Uint8Array): Hex {
  return `0x${Buffer.from(value).toString('hex')}`;
}

export function addressToBuffer(address: string): Buffer {
  if (!isAddress(address, { strict: false })) throw new TypeError('dirección inválida');
  return hexToBuffer(address.toLowerCase(), 20);
}

export function bufferToAddress(value: Uint8Array): Address {
  if (value.length !== 20) throw new TypeError('una dirección tiene 20 bytes');
  return getAddress(bufferToHex(value));
}

export function bytes32ToBuffer(value: string): Buffer {
  return hexToBuffer(value, 32);
}
