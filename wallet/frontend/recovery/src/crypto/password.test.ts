// P19.T02 [F-KEY-02]: Password R de 5 palabras uniformes (16 bits cada una), confirmación de 2 al azar y la forma
// normalizada que entra a Argon2id.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  confirmationPositions,
  confirmsPassword,
  newPasswordR,
  normalizePasswordR,
  PasswordError,
} from './password.ts';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { parseWordlist, type Wordlist } from './wordlist.ts';

let wordlist: Wordlist;

beforeAll(() => {
  wordlist = parseWordlist(wordlistText);
});

describe('Password R', () => {
  it('cada palabra son 16 bits big-endian del CSPRNG (índice en la lista)', () => {
    const fixed = Uint8Array.from([0, 0, 0, 2, 0xff, 0xff, 0x12, 0x34, 0x80, 0x00]);
    const words = newPasswordR(wordlist, () => fixed);
    expect(words).toEqual([
      wordlist.words[0],
      wordlist.words[2],
      wordlist.words[65_535],
      wordlist.words[0x1234],
      wordlist.words[0x8000],
    ]);
    // Los bytes aleatorios usados se borran.
    expect(fixed).toEqual(new Uint8Array(10));
  });

  it('con el CSPRNG real: 5 palabras de la lista, distintas en cada generación', () => {
    const a = newPasswordR(wordlist);
    const b = newPasswordR(wordlist);
    expect(a).toHaveLength(5);
    expect(a.every((w) => wordlist.index.has(w))).toBe(true);
    expect(a).not.toEqual(b);
  });

  it('confirmación: 2 posiciones distintas entre 0 y 4, que cubren todas las posiciones', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const positions = confirmationPositions();
      expect(positions).toHaveLength(2);
      expect(new Set(positions).size).toBe(2);
      expect(positions.every((p) => p >= 0 && p < 5)).toBe(true);
      positions.forEach((p) => seen.add(p));
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('el muestreo por rechazo descarta los valores que sesgarían el módulo', () => {
    // 0xffffffff está por encima del límite múltiplo de 5: se descarta y se usa el siguiente.
    const draws = [
      Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
      Uint8Array.from([0, 0, 0, 3]),
      Uint8Array.from([0, 0, 0, 3]),
      Uint8Array.from([0, 0, 0, 6]),
    ];
    expect(confirmationPositions(() => draws.shift() ?? new Uint8Array(4))).toEqual([1, 3]);
  });

  it('acepta la confirmación sin distinguir mayúsculas ni espacios, y sólo con las palabras pedidas', () => {
    const words = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
    expect(confirmsPassword(words, { 1: ' DOS ', 3: 'cuatro' }, [1, 3])).toBe(true);
    expect(confirmsPassword(words, { 1: 'dos', 3: 'tres' }, [1, 3])).toBe(false);
    expect(confirmsPassword(words, {}, [])).toBe(false);
  });

  it('normaliza lo escrito y exige 5 palabras de la lista', () => {
    const words = newPasswordR(wordlist);
    expect(normalizePasswordR(`  ${words.join('   ').toUpperCase()} `, wordlist)).toBe(words.join(' '));
    expect(() => normalizePasswordR(words.slice(0, 4).join(' '), wordlist)).toThrow('son 5 palabras');
    expect(() => normalizePasswordR(`${words.slice(0, 4).join(' ')} zzzzzzzzq`, wordlist)).toThrow(PasswordError);
  });
});
