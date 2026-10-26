// Restauración de U en un dispositivo nuevo [F-KEY-10] (P17.T09). Desde Drive, archivo o QR se obtiene el sobre y se
// desbloquea con la Password U de siempre (OPAQUE normal). Desde las 17 palabras: checksum → U → la dirección tiene que
// ser el rol U on-chain de la Safe (leído con el RPC propio y los contratos fijados) → Password U nueva → PlatformSession
// KEY_RESTORE con prueba de posesión (firma KeyRestore de U) → sobre nuevo con la versión vigente → backups → reemplazo
// del registro OPAQUE. Nunca se restaura una clave que no sea la U vigente.
import { isAddressEqual, type Address } from 'viem';
import { backupWordsToKey } from '../crypto/backup-words.ts';
import { zeroize } from '../crypto/bytes.ts';
import { sealKey, type KeyEnvelope } from '../crypto/envelope.ts';
import type { Argon2, KdfParams } from '../crypto/kdf.ts';
import { addressOf } from '../crypto/keys.ts';
import { signTypedDataWithKey } from '../crypto/sign.ts';
import { keyRestore } from '../crypto/typed-data.ts';
import type { Wordlist } from '../crypto/wordlist.ts';
import type { StorageFlags, WalletApi } from '../api/wallet-api.ts';
import type { OnchainRoles } from '../chain/roles.ts';
import { deriveForNewEnvelope } from '../onboarding/user-key.ts';
import { finishStepUp, type PendingStepUp, type StepUpCodes, type StepUpSession } from '../session/step-up.ts';
import { startRegistration } from '../unlock/opaque.ts';

export class RestoreError extends Error {
  override name = 'RestoreError';
}

/** U desde las palabras, sólo si es la U vigente on-chain de la Safe. */
export async function keyFromWords(
  words: readonly string[],
  wordlist: Wordlist,
  roles: () => Promise<OnchainRoles>,
): Promise<{ key: Uint8Array; address: Address }> {
  const key = await backupWordsToKey('U', words, wordlist);
  const address = addressOf(key);
  const current = await roles();
  if (!isAddressEqual(current.userKey, address)) {
    zeroize(key);
    throw new RestoreError(
      `Estas palabras son de la clave con la dirección ${address}, pero la dirección de la clave U vigente de tu Safe es ${current.userKey}: no se restaura`,
    );
  }
  return { key, address };
}

/** Prueba de posesión del step-up KEY_RESTORE: firma KeyRestore con el nonce que dio el backend. */
export async function finishKeyRestoreStepUp(
  api: WalletApi,
  pending: PendingStepUp,
  codes: Omit<StepUpCodes, 'keyRestore'>,
  restored: { key: Uint8Array; address: Address },
  context: { userId: string; walletId: string; walletFactory: Address },
): Promise<StepUpSession> {
  if (pending.scope !== 'KEY_RESTORE' || pending.keyRestoreNonce === null)
    throw new Error('step-up KEY_RESTORE sin nonce');
  const signature = signTypedDataWithKey(
    restored.key,
    keyRestore(context.walletFactory, {
      userId: context.userId,
      walletId: context.walletId,
      keyAddress: restored.address,
      nonce: pending.keyRestoreNonce,
    }),
  );
  return finishStepUp(api, pending, { ...codes, keyRestore: { keyAddress: restored.address, signature } });
}

export interface PreparedRestore {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
  registrationRecord: string;
  kdf: KdfParams;
}

/**
 * Sobre nuevo de U con la Password U nueva y la versión vigente (la informa el paso 1 de OPAQUE con KEY_RESTORE). Cada
 * intento deriva su propio AuthSecret_U y lo borra al terminar: un reintento registra con el secreto correcto (N1).
 */
export async function prepareRestoredEnvelope(
  api: WalletApi,
  stepUp: StepUpSession,
  restored: { key: Uint8Array; address: Address },
  password: string,
  platformId: string,
  argon2: Argon2,
): Promise<PreparedRestore> {
  const walletId = stepUp.session.walletId;
  if (walletId === null) throw new Error('la PlatformSession KEY_RESTORE no está atada a una wallet');
  const { encryptionKey, authSecret, kdf } = await deriveForNewEnvelope(password, 'U', argon2);
  if (authSecret === null) throw new Error('falta AuthSecret_U');
  try {
    const registration = await startRegistration(authSecret);
    const response = await api.userKeyOpaqueRegistration(stepUp.platform, walletId, registration.registrationRequest);
    const envelope = await sealKey(
      restored.key,
      encryptionKey,
      { platformId, chainId: 8453, walletId, role: 'U', keyAddress: restored.address, keyVersion: response.keyVersion },
      kdf,
    );
    return { envelope, encryptionKey, registrationRecord: registration.finish(response.registrationResponse), kdf };
  } finally {
    zeroize(authSecret);
  }
}

/** Con los backups del sobre nuevo: reemplazo del registro OPAQUE (la sesión KEY_RESTORE queda revocada). */
export async function commitRestore(
  api: WalletApi,
  stepUp: StepUpSession,
  prepared: PreparedRestore,
  storageFlags: StorageFlags,
): Promise<void> {
  await api.restoreUserKey(stepUp.platform, prepared.envelope.walletId, {
    registrationRecord: prepared.registrationRecord,
    kdfParams: prepared.kdf,
    storageFlags,
  });
}
