// Conversión hex ↔ bytea (direcciones de 20 bytes, hashes de 32).
import { describe, expect, it } from 'vitest';
import { addressToBuffer, bufferToAddress, bufferToHex, bytes32ToBuffer, hexToBuffer } from '../../src/lib/bytes.ts';

describe('bytes', () => {
  it('convierte direcciones a 20 bytes y de vuelta con checksum EIP-55', () => {
    const buf = addressToBuffer('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(buf).toHaveLength(20);
    expect(bufferToAddress(buf)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('rechaza direcciones y hex inválidos o de longitud incorrecta', () => {
    expect(() => addressToBuffer('0x123')).toThrow('dirección inválida');
    expect(() => hexToBuffer('0xzz')).toThrow('hex inválido');
    expect(() => hexToBuffer('0xabc')).toThrow('hex inválido');
    expect(() => bytes32ToBuffer('0x00')).toThrow('se esperaban 32 bytes');
    expect(() => bufferToAddress(Buffer.alloc(19))).toThrow('20 bytes');
  });

  it('hex ↔ buffer sin pérdida', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(bufferToHex(bytes32ToBuffer(hash))).toBe(hash);
    expect(bufferToHex(new Uint8Array([0, 1, 255]))).toBe('0x0001ff');
  });
});

describe('versión del servicio', () => {
  it('sale del package.json', async () => {
    const { serviceVersion } = await import('../../src/version.ts');
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(serviceVersion()).toBe(pkg.version);
  });
});
