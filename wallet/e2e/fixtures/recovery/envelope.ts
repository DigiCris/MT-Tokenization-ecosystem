// R cifrada como la tendría la app Recovery: el sobre `R.enc` sellado con el código de la app (src/crypto) y Argon2id
// nativo de Node (OpenSSL, mismos parámetros: el resultado es idéntico al del worker), con una Password R de 5
// palabras de la lista; también las 17 palabras de R para restaurar.
import { argon2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrivateKeyAccount } from 'viem/accounts';
import { recoveryKeyToWords } from '../../../frontend/recovery/src/crypto/backup-words.ts';
import { hexToBytes } from '../../../frontend/recovery/src/crypto/encoding.ts';
import {
  sealRecoveryKey,
  serializeRecoveryEnvelope,
  type RecoveryEnvelope,
} from '../../../frontend/recovery/src/crypto/envelope.ts';
import type { Argon2 } from '../../../frontend/recovery/src/crypto/kdf.ts';
import { newPasswordR } from '../../../frontend/recovery/src/crypto/password.ts';
import { parseWordlist, type Wordlist } from '../../../frontend/recovery/src/crypto/words.ts';
import { stack } from '../stack.ts';

export const nodeArgon2: Argon2 = (input) =>
  Promise.resolve(
    new Uint8Array(
      argon2Sync('argon2id', {
        message: Buffer.from(input.password),
        nonce: Buffer.from(input.salt),
        parallelism: input.parallelism,
        tagLength: input.outputLength,
        memory: input.memoryKiB,
        passes: input.iterations,
      }),
    ),
  );

let wordlist: Wordlist | null = null;

export function testWordlist(): Wordlist {
  wordlist ??= parseWordlist(
    readFileSync(resolve(import.meta.dirname, '../../../frontend/recovery/src/vendor/mtw-wordlist-v1.txt'), 'utf8'),
  );
  return wordlist;
}

export interface SealedRecovery {
  envelope: RecoveryEnvelope;
  /** El JSON del archivo descargable (el mismo que guarda la app). */
  file: string;
  passwordWords: string[];
}

/** Sella la clave de una cuenta de viem como R de la wallet, con una Password R nueva. */
export async function sealRecovery(
  account: PrivateKeyAccount,
  privateKey: `0x${string}`,
  walletId: string,
): Promise<SealedRecovery> {
  const passwordWords = newPasswordR(testWordlist());
  const key = hexToBytes(privateKey, 32);
  const opened = await sealRecoveryKey(
    key,
    passwordWords.join(' '),
    { platformId: stack().platformId, walletId, keyVersion: 1 },
    nodeArgon2,
  );
  if (opened.address !== account.address) throw new Error('la clave sellada no es la de la cuenta');
  return { envelope: opened.envelope, file: serializeRecoveryEnvelope(opened.envelope), passwordWords };
}

export async function recoveryWords(privateKey: `0x${string}`): Promise<string[]> {
  return recoveryKeyToWords(hexToBytes(privateKey, 32), testWordlist());
}
