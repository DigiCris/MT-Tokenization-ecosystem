// Backup humano de R ([F-KEY-06]): 17 palabras de MTW-WORDLIST-V1. Las 16 primeras son la clave en tramos de 16 bits
// big-endian; la 17.ª es `(versión << 12) | checksum12`, con versión 1 y checksum12 = primeros 12 bits de
// SHA-256("MTW-KEY-BACKUP-V1|R|" ‖ clave de 32 bytes). El rol entra en el checksum: un backup de U no se lee como R.
import { concatBytes, toBufferSource, utf8, wipe } from './encoding.ts';
import { isValidPrivateKey } from './secp256k1.ts';
import { normalizeWord, type Wordlist } from './words.ts';

export const BACKUP_WORDS = 17;
export const BACKUP_VERSION = 1;
const DOMAIN = 'MTW-KEY-BACKUP-V1|R|';

export class BackupWordsError extends Error {
  override name = 'BackupWordsError';
}

async function checksum12(key: Uint8Array): Promise<number> {
  const input = toBufferSource(concatBytes(utf8(DOMAIN), key));
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return (((digest[0] ?? 0) << 4) | ((digest[1] ?? 0) >> 4)) & 0xfff;
  } finally {
    wipe(input);
  }
}

export async function recoveryKeyToWords(key: Uint8Array, wordlist: Wordlist): Promise<string[]> {
  if (!isValidPrivateKey(key)) throw new BackupWordsError('clave R inválida');
  const indices: number[] = [];
  for (let i = 0; i < 32; i += 2) indices.push(((key[i] ?? 0) << 8) | (key[i + 1] ?? 0));
  indices.push((BACKUP_VERSION << 12) | (await checksum12(key)));
  return indices.map((index) => {
    const word = wordlist.words[index];
    if (word === undefined) throw new BackupWordsError('lista de palabras incompleta');
    return word;
  });
}

/** Las 17 palabras escritas por el usuario → R (32 bytes). Falla con el motivo si no son un backup de R válido. */
export async function wordsToRecoveryKey(text: string | readonly string[], wordlist: Wordlist): Promise<Uint8Array> {
  const words = (typeof text === 'string' ? text.split(/\s+/) : [...text]).map(normalizeWord).filter((w) => w !== '');
  if (words.length !== BACKUP_WORDS) throw new BackupWordsError('El backup de R son 17 palabras.');
  const indices = words.map((word) => {
    const index = wordlist.index.get(word);
    if (index === undefined) throw new BackupWordsError(`"${word}" no es una palabra de la lista.`);
    return index;
  });
  const last = indices[16] ?? 0;
  if (last >> 12 !== BACKUP_VERSION) throw new BackupWordsError('La palabra 17 no corresponde a un backup v1.');
  const key = new Uint8Array(32);
  indices.slice(0, 16).forEach((index, i) => {
    key[2 * i] = index >> 8;
    key[2 * i + 1] = index & 0xff;
  });
  if ((await checksum12(key)) !== (last & 0xfff) || !isValidPrivateKey(key)) {
    wipe(key);
    throw new BackupWordsError('Las palabras no son un backup de R válido (revisá el orden y que sean las de R).');
  }
  return key;
}
