// JSON canónico RFC 8785: orden de claves por unidades UTF-16, números y strings de ECMAScript, rechazos.
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from '../../src/lib/jcs.ts';

describe('canonicalJson (RFC 8785)', () => {
  it('ordena las claves por unidades de código UTF-16, en profundidad', () => {
    // Ejemplo de RFC 8785 §3.2.3: "€" (U+20AC) va después de "\r" y "1", y antes que el emoji (surrogates D83D…).
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(canonicalJson({ b: { d: 1, c: [3, { z: 0, a: 1 }] }, a: null })).toBe(
      '{"a":null,"b":{"c":[3,{"a":1,"z":0}],"d":1}}',
    );
  });

  it('serializa números como ECMAScript', () => {
    expect(canonicalJson([1e21, 1e-7, -0, 0.1, 123456789012345680000, 4.5])).toBe(
      '[1e+21,1e-7,0,0.1,123456789012345680000,4.5]',
    );
  });

  it('escapa strings como JSON.stringify (incluidos surrogates sueltos)', () => {
    expect(canonicalJson('a"b\\c\n\u0001\ud800')).toBe('"a\\"b\\\\c\\n\\u0001\\ud800"');
  });

  it('omite undefined en objetos y lo rechaza en arrays', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [10n], [() => 1], [Symbol('s')], [new Date(0)]])(
    'rechaza valores no serializables (%s)',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(CanonicalJsonError);
    },
  );
});
