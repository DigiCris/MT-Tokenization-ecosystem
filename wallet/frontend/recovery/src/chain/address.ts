// Direcciones escritas o pegadas por el usuario en Recovery (destino de una transferencia soberana, la Safe, S′ o un
// guard): EIP-55 válido o toda en minúsculas; una dirección con mayúsculas y checksum roto es un error de tipeo. También
// cómo se abrevia la dirección de una clave en lo que identifica sus backups (cuarta revisión de P17.MAN, hallazgo 1).
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem';

export class AddressInputError extends Error {
  override name = 'AddressInputError';
}

export function parseAddressInput(text: string, options: { allowZero?: boolean } = {}): Address {
  const value = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new AddressInputError('Escribí una dirección de Base (0x y 40 caracteres).');
  const mixed = value !== value.toLowerCase() && value.slice(2) !== value.slice(2).toUpperCase();
  if (mixed && !isAddress(value, { strict: true })) {
    throw new AddressInputError('La dirección tiene un error de tipeo (el checksum EIP-55 no coincide).');
  }
  const address = getAddress(value.toLowerCase());
  if (options.allowZero !== true && isAddressEqual(address, zeroAddress)) {
    throw new AddressInputError('La dirección cero no es válida acá.');
  }
  return address;
}

/**
 * El principio y el final de una dirección (EIP-55), como se escriben en los backups de una clave para distinguirlos de
 * los de otra: «0x F0c0 … 98bf».
 */
export function shortAddress(address: Address): string {
  const hex = getAddress(address).slice(2);
  return `0x ${hex.slice(0, 4)} … ${hex.slice(-4)}`;
}
