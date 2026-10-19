// Direcciones escritas por el usuario en Recovery: EIP-55 válido o todo en minúsculas; un checksum roto, una longitud
// incorrecta o la dirección cero (salvo que se permita, p. ej. para retirar un guard) se rechazan.
import { describe, expect, it } from 'vitest';
import { AddressInputError, parseAddressInput } from './address.ts';

const CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('parseAddressInput', () => {
  it('acepta EIP-55, minúsculas y mayúsculas; devuelve EIP-55', () => {
    expect(parseAddressInput(` ${CHECKSUMMED} `)).toBe(CHECKSUMMED);
    expect(parseAddressInput(CHECKSUMMED.toLowerCase())).toBe(CHECKSUMMED);
    expect(parseAddressInput(`0x${CHECKSUMMED.slice(2).toUpperCase()}`)).toBe(CHECKSUMMED);
  });

  it('rechaza checksum roto, longitud incorrecta y la dirección cero', () => {
    const broken = CHECKSUMMED.replace('fCD6', 'fcD6');
    expect(() => parseAddressInput(broken)).toThrow('checksum');
    expect(() => parseAddressInput('0x1234')).toThrow(AddressInputError);
    const zero = `0x${'0'.repeat(40)}`;
    expect(() => parseAddressInput(zero)).toThrow('cero');
    expect(parseAddressInput(zero, { allowZero: true })).toBe(zero);
  });
});
