// Password U ([F-KEY-02]): la genera la app como 5 palabras uniformes de MTW-WORDLIST-V1 (16 bits cada una, ≈ 80 bits:
// la lista tiene exactamente 2^16 palabras, así que cada índice sale directo de 2 bytes aleatorios, sin sesgo). El
// usuario la anota y la confirma reingresando 2 palabras al azar. Nunca se envía al backend ni se persiste. Las 17
// palabras de un backup se confirman igual, con posiciones al azar entre las 17.
import { randomBytes, zeroize } from './bytes.ts';
import type { Wordlist } from './wordlist.ts';

export const PASSWORD_WORDS = 5;
export const CONFIRMATION_WORDS = 2;

export function generatePassword(wordlist: Wordlist, random: (length: number) => Uint8Array = randomBytes): string[] {
  const bytes = random(PASSWORD_WORDS * 2);
  try {
    return Array.from({ length: PASSWORD_WORDS }, (_, i) => {
      const index = ((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0);
      const word = wordlist.words[index];
      if (word === undefined) throw new Error('índice fuera de la lista');
      return word;
    });
  } finally {
    zeroize(bytes);
  }
}

/** Forma canónica de la password que entra a Argon2id: palabras en minúsculas separadas por un espacio. */
export function normalizePassword(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Valida lo que tipeó el usuario: exactamente 5 palabras de la lista (devuelve las posiciones desconocidas). */
export function checkPasswordWords(input: string, wordlist: Wordlist): { ok: boolean; unknown: number[] } {
  const words = normalizePassword(input).split(' ').filter(Boolean);
  const unknown = words.flatMap((word, i) => (wordlist.index.has(word) ? [] : [i]));
  return { ok: words.length === PASSWORD_WORDS && unknown.length === 0, unknown };
}

/** Dos posiciones distintas (0-based) para la confirmación, uniformes (se descarta el byte 255: 255 = 5 · 51). */
export function confirmationPositions(random: (length: number) => Uint8Array = randomBytes): [number, number] {
  for (;;) {
    const [x = 255, y = 255] = random(2);
    if (x >= 255 || y >= 255) continue;
    const a = x % PASSWORD_WORDS;
    const b = y % PASSWORD_WORDS;
    if (a !== b) return a < b ? [a, b] : [b, a];
  }
}

/**
 * `count` posiciones distintas (0-based) entre `total` palabras, uniformes y ordenadas, para confirmar las 17 palabras
 * de un backup ([F-KEY-06].4): se descartan los bytes desde el mayor múltiplo de `total` que entra en un byte.
 */
export function randomPositions(
  total: number,
  count: number,
  random: (length: number) => Uint8Array = randomBytes,
): number[] {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(count) || total > 256 || count < 1 || count > total) {
    throw new RangeError('posiciones fuera de rango');
  }
  const limit = 256 - (256 % total);
  const chosen = new Set<number>();
  while (chosen.size < count) {
    for (const byte of random(count)) {
      if (byte < limit) chosen.add(byte % total);
      if (chosen.size === count) break;
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

export function confirmationMatches(
  words: readonly string[],
  positions: readonly number[],
  answers: readonly string[],
) {
  return (
    positions.length === answers.length && positions.every((p, i) => words[p] === normalizePassword(answers[i] ?? ''))
  );
}
