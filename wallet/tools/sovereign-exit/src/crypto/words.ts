// Backup de 17 palabras de U o de R ([F-KEY-06]): 16 palabras de MTW-WORDLIST-V1 con la clave de 32 bytes en tramos de
// 16 bits big-endian + la 17.ª = (versión 1 << 12) | checksum12, con checksum12 = primeros 12 bits de
// SHA-256("MTW-KEY-BACKUP-V1|" ‖ rol ‖ "|" ‖ clave). El rol entra en el checksum: las palabras de U no se leen como R.
// La lista va embebida en la herramienta y se verifica contra el SHA-256 fijado antes de usarla.
import { own, utf8, wipe } from './encoding.ts';
import type { KeyRole } from './envelope.ts';

/** wallet/config/wordlist/mtw-wordlist-v1.sha256 */
export const WORDLIST_SHA256 = 'c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e';

export interface Wordlist {
  readonly words: readonly string[];
  readonly index: ReadonlyMap<string, number>;
}

export class WordsError extends Error {
  override name = 'WordsError';
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own(bytes)));
}

/** Verifica el SHA-256 del texto contra el fijado y recién entonces lo interpreta. */
export async function verifiedWordlist(text: string): Promise<Wordlist> {
  const digest = Array.from(await sha256(utf8(text)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (digest !== WORDLIST_SHA256) throw new WordsError('La lista de palabras embebida no es la fijada: no se usa.');
  const words = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  if (words.length !== 65_536) throw new WordsError('La lista de palabras no tiene 65.536 entradas.');
  return { words, index: new Map(words.map((w, i) => [w, i])) };
}

async function checksum12(role: KeyRole, key: Uint8Array): Promise<number> {
  const prefix = utf8(`MTW-KEY-BACKUP-V1|${role}|`);
  const input = new Uint8Array(prefix.length + key.length);
  input.set(prefix);
  input.set(key, prefix.length);
  try {
    const digest = await sha256(input);
    return (((digest[0] ?? 0) << 4) | ((digest[1] ?? 0) >> 4)) & 0xfff;
  } finally {
    wipe(input);
  }
}

/** Las 17 palabras → la clave de 32 bytes de ese rol. Falla con el motivo (palabra desconocida, checksum, versión). */
export async function wordsToKey(role: KeyRole, text: string, wordlist: Wordlist): Promise<Uint8Array> {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 17) throw new WordsError('El backup son 17 palabras.');
  const indices = words.map((word, i) => {
    const index = wordlist.index.get(word);
    if (index === undefined) throw new WordsError(`La palabra ${String(i + 1)} ("${word}") no es de la lista.`);
    return index;
  });
  const last = indices[16] ?? 0;
  if (last >> 12 !== 1) throw new WordsError('La palabra 17 no corresponde a un backup v1.');
  const key = new Uint8Array(32);
  indices.slice(0, 16).forEach((index, i) => {
    key[2 * i] = index >> 8;
    key[2 * i + 1] = index & 0xff;
  });
  if ((await checksum12(role, key)) !== (last & 0xfff)) {
    wipe(key);
    throw new WordsError(
      `Las palabras no son un backup de ${role} válido (revisá el orden y que sean las de ${role}).`,
    );
  }
  return key;
}
