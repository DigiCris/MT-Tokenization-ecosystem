// Direcciones escritas o pegadas por el usuario en Recovery (destino de una transferencia soberana, la Safe, S′ o un
// guard): EIP-55 válido o toda en minúsculas; una dirección con mayúsculas y checksum roto es un error de tipeo.
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
