// P19.T08 [F-KEY-10]: restaurar R. Las 17 palabras del vector dan la R del vector (un backup de U no), R restaurada se
// re-cifra con una Password R nueva para la wallet y el sobre nuevo se abre con esa Password; y R se acepta sólo si es,
// on-chain, la recoveryKey del Guard para la Safe y uno de sus owners.
import { getAddress, keccak256, toBytes, type Address } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import backupVectors from '../../test/vectors/wire/backup-words.json' with { type: 'json' };
import { toBufferSource } from '../crypto/encoding.ts';
import { openRecoveryEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOfKey } from '../crypto/secp256k1.ts';
import { parseWordlist, type Wordlist } from '../crypto/wordlist.ts';
import wordlistText from '../vendor/mtw-wordlist-v1.txt?raw';
import { recoveryFromWords, resealRecovery, RestoreError, verifyRestoredRecovery } from './restore.ts';

let wordlist: Wordlist;
const recovery = backupVectors.backups.find((b) => b.role === 'R');
const user = backupVectors.backups.find((b) => b.role === 'U');
if (!recovery || !user) throw new Error('faltan los vectores de palabras');

beforeAll(() => {
  wordlist = parseWordlist(wordlistText);
});

/** Argon2id de prueba: determinístico y rápido (el real lo cubre el vector del sobre en src/crypto). */
const fastArgon2: Argon2 = async ({ password, salt }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));

const GUARD = getAddress('0x00000000000000000000000000000000000000f2');
const SAFE = getAddress('0x00000000000000000000000000000000000000c1');
const U = getAddress('0x00000000000000000000000000000000000000a1');
const S = getAddress('0x00000000000000000000000000000000000000a3');

function chain(recoveryKey: Address, owners: Address[]) {
  return {
    readContract: ({ functionName }: { functionName: string }) =>
      Promise.resolve(
        functionName === 'rolesOf' ? { initialized: true, userKey: U, recoveryKey, executor: S } : owners,
      ),
  } as never;
}

describe('desde las 17 palabras', () => {
  it('las palabras del vector dan la R del vector; las de U no se aceptan como R', async () => {
    const restored = await recoveryFromWords(recovery.words.join(' '), wordlist);
    expect(restored.address).toBe(recovery.keyAddress);
    expect(restored.key).toEqual(toBytes(keccak256(toBytes(recovery.keyLabel))));
    await expect(recoveryFromWords(user.words.join(' '), wordlist)).rejects.toThrow('no son un backup de R');
  });

  it('R restaurada se re-cifra para la wallet con la Password R nueva y el sobre nuevo se abre con ella', async () => {
    const { key, address } = await recoveryFromWords(recovery.words.join(' '), wordlist);
    const password = ['uno', 'dos', 'tres', 'cuatro', 'cinco'].map((_, i) => wordlist.words[i * 1000] ?? '');
    const walletId = '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5';
    const sealed = await resealRecovery(key, password, { platformId: 'mtw', walletId }, fastArgon2);
    expect(sealed.envelope).toMatchObject({ role: 'R', walletId, keyAddress: address, keyVersion: 1 });
    const reopened = await openRecoveryEnvelope(sealed.envelope, password.join(' '), fastArgon2);
    expect(reopened.address).toBe(addressOfKey(key));
  });
});

describe('verificación en Base', () => {
  const R = getAddress(recovery.keyAddress);

  it('R vigente (rol R del Guard y owner de la Safe): se restaura', async () => {
    await expect(verifyRestoredRecovery(chain(R, [U, R, S]), GUARD, SAFE, R)).resolves.toBeUndefined();
  });

  it('otra R en el Guard (p. ej. ya se rotó) o no owner: no se restaura', async () => {
    await expect(verifyRestoredRecovery(chain(S, [U, R, S]), GUARD, SAFE, R)).rejects.toThrow(RestoreError);
    await expect(verifyRestoredRecovery(chain(R, [U, S]), GUARD, SAFE, R)).rejects.toThrow('no es owner');
  });
});
