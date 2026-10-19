// P19.T02: codificaciones estrictas del módulo crypto de Recovery (hex, base64url canónico, UTF-8 fatal).
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  EncodingError,
  fromUtf8,
  hexToBytes,
  toBufferSource,
  utf8,
  wipe,
} from './encoding.ts';

describe('hex', () => {
  it('ida y vuelta, sin distinguir mayúsculas al leer', () => {
    const bytes = Uint8Array.from([0, 1, 0xab, 0xff]);
    expect(bytesToHex(bytes)).toBe('0x0001abff');
    expect(hexToBytes('0x0001ABff')).toEqual(bytes);
    expect(hexToBytes('0x')).toEqual(new Uint8Array());
  });

  it('rechaza lo que no es hex de bytes completos o no tiene el largo pedido', () => {
    for (const bad of ['0001', '0x0', '0xzz', '0x 00', ' 0x00']) expect(() => hexToBytes(bad)).toThrow(EncodingError);
    expect(() => hexToBytes('0x0011', 3)).toThrow('se esperaban 3 bytes');
    expect(hexToBytes('0x001122', 3)).toHaveLength(3);
  });
});

describe('base64url', () => {
  it('sin relleno, con el alfabeto url-safe', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x00, 0x01]);
    expect(bytesToBase64Url(bytes)).toBe('-_-_AAE');
    expect(base64UrlToBytes('-_-_AAE')).toEqual(bytes);
    expect(base64UrlToBytes('')).toEqual(new Uint8Array());
  });

  it('rechaza relleno, alfabeto estándar, largos imposibles y formas no canónicas', () => {
    for (const bad of ['AAE=', '+/+/AAE', 'A', 'AAF']) expect(() => base64UrlToBytes(bad)).toThrow(EncodingError);
    expect(() => base64UrlToBytes('AAAA', 2)).toThrow('se esperaban 2 bytes');
  });
});

describe('utf8 y bytes', () => {
  it('UTF-8 con decodificación fatal', () => {
    expect(fromUtf8(utf8('Contraseña ✓'))).toBe('Contraseña ✓');
    expect(() => fromUtf8(Uint8Array.from([0xc3]))).toThrow();
  });

  it('concatena, copia a un buffer propio y borra', () => {
    const joined = concatBytes(Uint8Array.from([1, 2]), new Uint8Array(), Uint8Array.from([3]));
    expect(joined).toEqual(Uint8Array.from([1, 2, 3]));
    const copy = toBufferSource(joined);
    expect(copy).toEqual(joined);
    expect(copy.buffer).not.toBe(joined.buffer);
    wipe(joined);
    expect(joined).toEqual(new Uint8Array(3));
    expect(copy).toEqual(Uint8Array.from([1, 2, 3]));
  });
});
