// Restaurar R en este dispositivo (P19.T08, [F-KEY-10]): el sobre `R.enc` (Drive de Recovery, archivo o QR) se abre con
// la Password R; desde las 17 palabras se recupera R y se re-cifra con una Password R nueva para la wallet de la
// PlatformSession. En los dos casos R tiene que ser, on-chain, la recoveryKey del Guard para la Safe y uno de sus
// owners: una clave que no es la R vigente no se restaura.
import { isAddressEqual, type Address } from 'viem';
import type { ChainReader } from '../chain/client.ts';
import { readRoles, safeOwners } from '../chain/rotations.ts';
import { wordsToRecoveryKey } from '../crypto/backup-words.ts';
import { sealRecoveryKey, type OpenedEnvelope } from '../crypto/envelope.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { addressOfKey } from '../crypto/secp256k1.ts';
import type { Wordlist } from '../crypto/words.ts';

type Reader = Pick<ChainReader, 'readContract'>;

export class RestoreError extends Error {
  override name = 'RestoreError';
}

/** R vigente on-chain: recoveryKey del Guard para la Safe y owner de la Safe. */
export async function verifyRestoredRecovery(
  reader: Reader,
  guard: Address,
  safe: Address,
  recoveryKey: Address,
): Promise<void> {
  const [roles, owners] = await Promise.all([readRoles(reader, guard, safe), safeOwners(reader, safe)]);
  if (!isAddressEqual(roles.recoveryKey, recoveryKey)) {
    throw new RestoreError(
      'Esta clave no es la clave de recuperación vigente de tu Safe (en Base, el rol R tiene otra dirección).',
    );
  }
  if (!owners.some((owner) => isAddressEqual(owner, recoveryKey))) {
    throw new RestoreError('Esta clave no es owner de tu Safe.');
  }
}

export interface WordsRecovery {
  /** R en claro: se usa para re-cifrarla y se borra enseguida. */
  key: Uint8Array;
  address: Address;
}

/** Las 17 palabras → R (con el checksum del rol R: un backup de U no se acepta). */
export async function recoveryFromWords(text: string, wordlist: Wordlist): Promise<WordsRecovery> {
  const key = await wordsToRecoveryKey(text, wordlist);
  return { key, address: addressOfKey(key) };
}

/** Re-cifra R con la Password R nueva (ya confirmada) para la wallet de la PlatformSession. No borra `key`. */
export function resealRecovery(
  key: Uint8Array,
  passwordWords: readonly string[],
  context: { platformId: string; walletId: string },
  argon2: Argon2,
): Promise<OpenedEnvelope> {
  return sealRecoveryKey(key, passwordWords.join(' '), { ...context, keyVersion: 1 }, argon2);
}
