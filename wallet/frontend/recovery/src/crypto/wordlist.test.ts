// P19.T02 [F-KEY-02]: la copia de MTW-WORDLIST-V1 de la app se usa sólo si su SHA-256 es el fijado.
import { describe, expect, it, vi } from 'vitest';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { toBufferSource, utf8 } from './encoding.ts';
import { loadWordlist, normalizeWord, parseWordlist, verifiedWordlist, WordlistError } from './wordlist.ts';

// La lista es ASCII: sus bytes son los del texto.
const bytes = utf8(wordlistText);

describe('MTW-WORDLIST-V1', () => {
  it('la copia verificada tiene las 65.536 palabras de niceware en orden', async () => {
    const list = await verifiedWordlist(bytes);
    expect(list.words).toHaveLength(65_536);
    expect(list.words[0]).toBe('a');
    expect(list.words[65_535]).toBe('zyzzyva');
    expect(list.index.get('aardvark')).toBe(2);
  });

  it('un byte cambiado: la lista no se usa', async () => {
    const tampered = bytes.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    await expect(verifiedWordlist(tampered)).rejects.toThrow('no coincide con la fijada');
  });

  it('el parser rechaza listas incompletas, repetidas o con caracteres raros', () => {
    expect(() => parseWordlist('a\nb\n')).toThrow(WordlistError);
    const words = Array.from(
      { length: 65_536 },
      (_, i) => `w${'a'.repeat(1 + (i % 7))}${String.fromCharCode(97 + (i % 26))}`,
    );
    expect(() => parseWordlist(words.join('\n'))).toThrow(WordlistError);
  });

  it('carga una vez por pestaña desde el asset del build y reintenta si falló', async () => {
    const failing = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(loadWordlist(failing)).rejects.toThrow('no se pudo cargar');
    const ok = vi.fn(() => Promise.resolve(new Response(toBufferSource(bytes))));
    const first = await loadWordlist(ok);
    const second = await loadWordlist(ok);
    expect(second).toBe(first);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('normaliza lo que escribe el usuario', () => {
    expect(normalizeWord('  AardVark ')).toBe('aardvark');
  });
});
