// Backup humano de la clave ([F-KEY-06].4): 16 palabras de MTW-WORDLIST-V1 (la clave de 32 bytes en tramos de 16 bits
// big-endian) + una palabra 17 = (versión de 4 bits << 12) | checksum12, con checksum12 = primeros 12 bits de
// SHA-256("MTW-KEY-BACKUP-V1|" ‖ rol ‖ "|" ‖ clave). Un error de tipeo cambia el checksum (falso positivo 1/4096) y una
// palabra que no está en la lista se informa con su posición.
import { ownBuffer, utf8, zeroize } from './bytes.ts';
import type { KeyRole } from './kdf.ts';
import { isValidPrivateKey } from './keys.ts';
import type { Wordlist } from './wordlist.ts';

export const BACKUP_VERSION = 1;
export const BACKUP_WORDS = 17;

export class BackupWordsError extends Error {
  override name = 'BackupWordsError';
  readonly positions: readonly number[];

  constructor(message: string, positions: readonly number[] = []) {
    super(message);
    this.positions = positions;
  }
}

export async function backupChecksum(role: KeyRole, key: Uint8Array): Promise<number> {
  const prefix = utf8(`MTW-KEY-BACKUP-V1|${role}|`);
  const input = new Uint8Array(prefix.length + key.length);
  input.set(prefix);
  input.set(key, prefix.length);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(input)));
    return ((digest[0] ?? 0) << 4) | ((digest[1] ?? 0) >> 4);
  } finally {
    zeroize(input);
  }
}

export async function keyToBackupWords(role: KeyRole, key: Uint8Array, wordlist: Wordlist): Promise<string[]> {
  if (!isValidPrivateKey(key)) throw new BackupWordsError('clave inválida');
  const indices = Array.from({ length: 16 }, (_, i) => (((key[2 * i] ?? 0) << 8) | (key[2 * i + 1] ?? 0)) >>> 0);
  indices.push((BACKUP_VERSION << 12) | (await backupChecksum(role, key)));
  return indices.map((index) => {
    const word = wordlist.words[index];
    if (word === undefined) throw new BackupWordsError('índice fuera de la lista');
    return word;
  });
}

/** Normaliza lo tipeado (minúsculas, espacios simples) y lo separa en palabras. */
export function splitBackupWords(input: string): string[] {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export async function backupWordsToKey(
  role: KeyRole,
  words: readonly string[],
  wordlist: Wordlist,
): Promise<Uint8Array> {
  if (words.length !== BACKUP_WORDS) throw new BackupWordsError(`se esperan ${String(BACKUP_WORDS)} palabras`);
  const unknown = words.flatMap((word, i) => (wordlist.index.has(word) ? [] : [i]));
  if (unknown.length > 0) throw new BackupWordsError('hay palabras que no están en la lista', unknown);
  const indices = words.map((word) => wordlist.index.get(word) ?? 0);
  const last = indices[16] ?? 0;
  if (last >> 12 !== BACKUP_VERSION) throw new BackupWordsError('versión de backup desconocida', [16]);
  const key = new Uint8Array(32);
  indices.slice(0, 16).forEach((index, i) => {
    key[2 * i] = index >> 8;
    key[2 * i + 1] = index & 0xff;
  });
  if ((last & 0xfff) !== (await backupChecksum(role, key)) || !isValidPrivateKey(key)) {
    zeroize(key);
    throw new BackupWordsError('el checksum no coincide: revisá las palabras');
  }
  return key;
}
