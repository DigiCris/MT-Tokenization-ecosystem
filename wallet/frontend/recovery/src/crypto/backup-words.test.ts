// P19.T02 [F-KEY-06]: las 17 palabras de R contra el vector copiado de contracts/; un backup de U, una palabra fuera de
// lugar o una versión desconocida no se leen como R.
import { keccak256, toBytes } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import backupVectors from '../../test/vectors/wire/backup-words.json' with { type: 'json' };
import { BackupWordsError, recoveryKeyToWords, wordsToRecoveryKey } from './backup-words.ts';
import { addressOfKey, newPrivateKey } from './secp256k1.ts';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { parseWordlist, type Wordlist } from './wordlist.ts';

let wordlist: Wordlist;
const recovery = backupVectors.backups.find((b) => b.role === 'R');
const user = backupVectors.backups.find((b) => b.role === 'U');

beforeAll(() => {
  wordlist = parseWordlist(wordlistText);
});

describe('17 palabras de R', () => {
  it('el vector: mismas palabras, índices y checksum; se leen de vuelta a la clave de R', async () => {
    expect(recovery).toBeDefined();
    if (!recovery) return;
    const key = toBytes(keccak256(toBytes(recovery.keyLabel)));
    expect(addressOfKey(key)).toBe(recovery.keyAddress);
    const words = await recoveryKeyToWords(key, wordlist);
    expect(words).toEqual(recovery.words);
    expect(words.map((w) => wordlist.index.get(w))).toEqual(recovery.indices);
    expect((recovery.indices[16] ?? 0) & 0xfff).toBe(recovery.checksum12);
    expect(await wordsToRecoveryKey(recovery.words.join(' '), wordlist)).toEqual(key);
    expect(await wordsToRecoveryKey(`  ${recovery.words.join('  ').toUpperCase()} `, wordlist)).toEqual(key);
  });

  it('ida y vuelta con claves nuevas', async () => {
    for (let i = 0; i < 8; i++) {
      const key = newPrivateKey();
      expect(await wordsToRecoveryKey(await recoveryKeyToWords(key, wordlist), wordlist)).toEqual(key);
    }
  });

  it('el backup de U (el rol entra en el checksum) no se lee como R', async () => {
    expect(user).toBeDefined();
    await expect(wordsToRecoveryKey(user?.words ?? [], wordlist)).rejects.toThrow('no son un backup de R válido');
  });

  it('rechaza cantidad equivocada, palabras desconocidas, otro orden y otra versión', async () => {
    const words = recovery?.words ?? [];
    await expect(wordsToRecoveryKey(words.slice(0, 16), wordlist)).rejects.toThrow('17 palabras');
    await expect(wordsToRecoveryKey([...words.slice(0, 16), 'zzzzzzzzq'], wordlist)).rejects.toThrow(
      'no es una palabra de la lista',
    );
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1] ?? '', swapped[0] ?? ''];
    await expect(wordsToRecoveryKey(swapped, wordlist)).rejects.toBeInstanceOf(BackupWordsError);
    const last = wordlist.index.get(words[16] ?? '') ?? 0;
    const otherVersion = wordlist.words[(2 << 12) | (last & 0xfff)] ?? '';
    await expect(wordsToRecoveryKey([...words.slice(0, 16), otherVersion], wordlist)).rejects.toThrow('backup v1');
  });

  it('no arma palabras de una clave inválida', async () => {
    await expect(recoveryKeyToWords(new Uint8Array(32), wordlist)).rejects.toThrow('clave R inválida');
  });
});
