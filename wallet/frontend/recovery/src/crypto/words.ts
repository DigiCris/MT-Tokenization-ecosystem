// MTW-WORDLIST-V1 sin el asset ([F-KEY-02], ADR-013): la forma de la lista (65.536 palabras de a-z, sin repetir: 16
// bits cada una), su parseo y la normalización de lo que escribe el usuario. Sin imports del build: lo usan también
// las herramientas y los tests de Node; la carga del asset verificado vive en wordlist.ts.

export const WORDLIST_SIZE = 65_536;

export interface Wordlist {
  readonly words: readonly string[];
  readonly index: ReadonlyMap<string, number>;
}

export class WordlistError extends Error {
  override name = 'WordlistError';
}

export function parseWordlist(text: string): Wordlist {
  const words = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (words.length !== WORDLIST_SIZE) throw new WordlistError('la lista de palabras no tiene 65.536 entradas');
  const index = new Map<string, number>();
  words.forEach((word, i) => {
    if (!/^[a-z]+$/.test(word) || index.has(word)) throw new WordlistError(`palabra inválida o repetida: ${word}`);
    index.set(word, i);
  });
  return { words, index };
}

/** Palabra escrita por el usuario: minúsculas y sin espacios alrededor. */
export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}
