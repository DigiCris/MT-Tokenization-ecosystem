// Password R ([F-KEY-02]): la genera la app, 5 palabras uniformes de MTW-WORDLIST-V1 (16 bits cada una, ≈ 80 bits), que
// el usuario anota y confirma reingresando 2 al azar. Nunca se envía al backend ni se persiste; lo que entra a Argon2id
// es la forma normalizada (minúsculas, un espacio entre palabras).
import { randomBytes, type RandomBytes } from './secp256k1.ts';
import { normalizeWord, type Wordlist } from './words.ts';

export const PASSWORD_WORDS = 5;
export const CONFIRMATION_WORDS = 2;

export class PasswordError extends Error {
  override name = 'PasswordError';
}

/** Índice uniforme en [0, n) por rechazo (sin sesgo de módulo). */
function uniformIndex(n: number, random: RandomBytes): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const bytes = random(4);
    const value =
      ((bytes[0] ?? 0) * 0x100_0000 + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0)) >>> 0;
    if (value < limit) return value % n;
  }
}

/** 5 palabras: cada una, 16 bits del CSPRNG (la lista tiene exactamente 2^16). */
export function newPasswordR(wordlist: Wordlist, random: RandomBytes = randomBytes): string[] {
  const bytes = random(2 * PASSWORD_WORDS);
  const words = Array.from({ length: PASSWORD_WORDS }, (_, i) => {
    const index = ((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0);
    const word = wordlist.words[index];
    if (word === undefined) throw new PasswordError('lista de palabras incompleta');
    return word;
  });
  bytes.fill(0);
  return words;
}

/** Posiciones (0–4, distintas y ordenadas) que el usuario tiene que reingresar para confirmar que las anotó. */
export function confirmationPositions(random: RandomBytes = randomBytes): number[] {
  const picked = new Set<number>();
  while (picked.size < CONFIRMATION_WORDS) picked.add(uniformIndex(PASSWORD_WORDS, random));
  return [...picked].sort((a, b) => a - b);
}

export function confirmsPassword(
  words: readonly string[],
  typed: Readonly<Record<number, string>>,
  positions: readonly number[],
): boolean {
  return (
    positions.length > 0 && positions.every((i) => words[i] !== undefined && normalizeWord(typed[i] ?? '') === words[i])
  );
}

/** Lo que escribe el usuario → la forma que entra a Argon2id; falla si no son 5 palabras de la lista. */
export function normalizePasswordR(text: string, wordlist: Wordlist): string {
  const words = text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length !== PASSWORD_WORDS) throw new PasswordError('La Password R son 5 palabras.');
  const unknown = words.find((word) => !wordlist.index.has(word));
  if (unknown !== undefined) throw new PasswordError(`"${unknown}" no es una palabra de la lista de Password R.`);
  return words.join(' ');
}
