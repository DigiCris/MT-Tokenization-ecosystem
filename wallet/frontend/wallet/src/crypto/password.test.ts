// [F-KEY-02]: MTW-WORDLIST-V1 se verifica antes de usarse (también cuando se carga del propio origin) y la Password U
// son 5 palabras uniformes de la lista con confirmación de 2 posiciones al azar.
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
