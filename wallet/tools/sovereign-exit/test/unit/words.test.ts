// 17 palabras de U y de R contra los vectores de contracts/: dan la clave de la label; las de un rol no se leen como
// del otro; una palabra fuera de la lista se informa con su posición. La lista embebida es la fijada (SHA-256) y es la
// misma que wallet/config/wordlist.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifiedWordlist, wordsToKey, WordsError, type Wordlist } from '../../src/crypto/words.ts';
import { vector, type BackupVector } from './vectors.ts';

const text = readFileSync(resolve(import.meta.dirname, '../../src/vendor/mtw-wordlist-v1.txt'), 'utf8');
const { backups } = vector('wire/backup-words.json') as { backups: BackupVector[] };
let wordlist: Wordlist;

beforeAll(async () => {
  wordlist = await verifiedWordlist(text);
});

describe('lista de palabras', () => {
  it('es la de wallet/config/wordlist y su SHA-256 es el fijado', async () => {
    expect(text).toBe(
      readFileSync(resolve(import.meta.dirname, '../../../../config/wordlist/mtw-wordlist-v1.txt'), 'utf8'),
    );
    await expect(verifiedWordlist(`${text}x`)).rejects.toThrow('no es la fijada');
  });
});

describe('17 palabras', () => {
  it.each(backups.map((b) => [b.role, b] as const))('%s: la clave de la label', async (role, backup) => {
    expect(await wordsToKey(role, backup.words.join(' '), wordlist)).toEqual(
      toBytes(keccak256(toBytes(backup.keyLabel))),
    );
  });

  it('las palabras de U no se leen como R (el rol entra en el checksum)', async () => {
    const user = backups.find((b) => b.role === 'U');
    if (!user) throw new Error('falta el vector de U');
    await expect(wordsToKey('R', user.words.join(' '), wordlist)).rejects.toThrow('no son un backup de R');
  });

  it('cantidad, palabra desconocida y versión', async () => {
    const user = backups.find((b) => b.role === 'U');
    if (!user) throw new Error('falta el vector de U');
    await expect(wordsToKey('U', user.words.slice(1).join(' '), wordlist)).rejects.toThrow('17 palabras');
    const unknown = [...user.words];
    unknown[3] = 'zzzzzz';
    await expect(wordsToKey('U', unknown.join(' '), wordlist)).rejects.toThrow('La palabra 4');
    const version = [...user.words];
    version[16] = wordlist.words[0] ?? '';
    await expect(wordsToKey('U', version.join(' '), wordlist)).rejects.toBeInstanceOf(WordsError);
  });
});
