// [F-KEY-02]: MTW-WORDLIST-V1 se verifica antes de usarse (también cuando se carga del propio origin) y la Password U
// son 5 palabras uniformes de la lista con confirmación de 2 posiciones al azar; las 17 palabras de un backup se
// confirman con posiciones al azar entre las 17 ([F-KEY-06].4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { utf8 } from './bytes.ts';
import {
  checkPasswordWords,
  confirmationMatches,
  confirmationPositions,
  generatePassword,
  normalizePassword,
  PASSWORD_WORDS,
  randomPositions,
} from './password.ts';
import { loadWordlist, parseWordlist, verifyWordlist, WORDLIST_SIZE } from './wordlist.ts';

const bytes = () => {
  const encoded = utf8(wordlistText);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
};

describe('MTW-WORDLIST-V1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('se verifica antes de interpretarla: una lista alterada no se usa', async () => {
    const list = await verifyWordlist(bytes());
    expect(list.words).toHaveLength(WORDLIST_SIZE);
    expect(list.index.get(list.words[12_345] ?? '')).toBe(12_345);
    const tampered = new Uint8Array(bytes());
    tampered[0] = 'b'.charCodeAt(0);
    await expect(verifyWordlist(tampered.buffer)).rejects.toThrow('SHA-256');
  });

  it('rechaza listas con otra cantidad de palabras, repetidas o con caracteres fuera de a-z', () => {
    expect(() => parseWordlist('a\nb\n')).toThrow('cantidad');
    const words = wordlistText.slice(0, -1).split('\n');
    expect(() => parseWordlist([words[1], ...words.slice(1)].join('\n'))).toThrow('repetida');
    expect(() => parseWordlist(['Ñandú', ...words.slice(1)].join('\n'))).toThrow('inválida');
    expect(parseWordlist(words.join('\n')).words).toHaveLength(WORDLIST_SIZE);
  });

  it('loadWordlist la baja del propio origin una sola vez y reintenta si falló', async () => {
    const failing = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 })));
    await expect(loadWordlist(failing)).rejects.toThrow('503');
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(bytes())));
    const [a, b] = await Promise.all([loadWordlist(fetcher), loadWordlist(fetcher)]);
    expect(a).toBe(b);
    expect(a.words).toHaveLength(WORDLIST_SIZE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/mtw-wordlist-v1\.txt/));
  });
});

describe('Password U', () => {
  const wordlist = parseWordlist(wordlistText);

  it('5 palabras: cada índice sale de 2 bytes aleatorios (16 bits, sin sesgo) y los bytes se borran', () => {
    const random = Uint8Array.of(0x00, 0x00, 0xff, 0xff, 0x12, 0x34, 0x80, 0x00, 0x00, 0x01);
    const words = generatePassword(wordlist, () => random);
    expect(words).toEqual([0x0000, 0xffff, 0x1234, 0x8000, 0x0001].map((i) => wordlist.words[i]));
    expect(random.every((b) => b === 0)).toBe(true);
    const fresh = generatePassword(wordlist);
    expect(fresh).toHaveLength(PASSWORD_WORDS);
    expect(fresh.every((w) => wordlist.index.has(w))).toBe(true);
  });

  it('normaliza y valida lo tipeado', () => {
    const words = generatePassword(wordlist);
    expect(normalizePassword(`  ${words.join('   ').toUpperCase()} `)).toBe(words.join(' '));
    expect(checkPasswordWords(words.join(' '), wordlist)).toEqual({ ok: true, unknown: [] });
    expect(checkPasswordWords(`${words.slice(0, 4).join(' ')} zzzzqq`, wordlist)).toEqual({ ok: false, unknown: [4] });
    expect(checkPasswordWords(words.slice(0, 4).join(' '), wordlist).ok).toBe(false);
    expect(checkPasswordWords(`${words.join(' ')} ${words[0] ?? ''}`, wordlist).ok).toBe(false);
  });

  it('confirma 2 posiciones distintas y uniformes (descarta el byte 255 y re-sortea las iguales)', () => {
    const words = generatePassword(wordlist);
    const sequence = [Uint8Array.of(255, 1), Uint8Array.of(2, 7), Uint8Array.of(3, 1)];
    let call = 0;
    const positions = confirmationPositions(() => sequence[call++] ?? Uint8Array.of(0, 1));
    expect(call).toBe(3);
    expect(positions).toEqual([1, 3]);
    expect(confirmationMatches(words, positions, [words[1] ?? '', ` ${(words[3] ?? '').toUpperCase()}`])).toBe(true);
    expect(confirmationMatches(words, positions, [words[1] ?? '', words[2] ?? ''])).toBe(false);
    expect(confirmationMatches(words, positions, [words[1] ?? ''])).toBe(false);
    for (let i = 0; i < 50; i++) {
      const [a, b] = confirmationPositions();
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(PASSWORD_WORDS);
    }
  });
});

describe('confirmación de las 17 palabras de un backup', () => {
  it('posiciones distintas, ordenadas y uniformes: descarta los bytes que sesgarían el módulo y las repetidas', () => {
    // 17 palabras: 256 % 17 = 1, así que el byte 255 se descarta; 18 % 17 = 1 repite la posición 1.
    const sequence = [Uint8Array.of(255, 1, 18), Uint8Array.of(33, 4, 200)];
    let call = 0;
    const positions = randomPositions(17, 3, () => sequence[call++] ?? Uint8Array.of(0, 0, 0));
    expect(call).toBe(2);
    expect(positions).toEqual([1, 4, 16]);
    expect(randomPositions(17, 3, () => Uint8Array.of(16, 0, 5))).toEqual([0, 5, 16]);
    for (let i = 0; i < 50; i++) {
      const drawn = randomPositions(17, 3);
      expect(new Set(drawn).size).toBe(3);
      expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
      expect(drawn.every((p) => p >= 0 && p < 17)).toBe(true);
    }
  });

  it('rechaza pedidos imposibles', () => {
    expect(() => randomPositions(17, 0)).toThrow(RangeError);
    expect(() => randomPositions(3, 4)).toThrow(RangeError);
    expect(() => randomPositions(257, 1)).toThrow(RangeError);
  });
});
