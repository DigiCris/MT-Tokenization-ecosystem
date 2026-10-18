// Cambio de Password U [F-KEY-08] (P17.T07): con la wallet desbloqueada (PlatformSession OPERATIONS), U se descifra con
// K_U sólo para re-cifrarla con salt y Password U nuevos (U no cambia); la UI sube el sobre nuevo a Drive y ofrece el
// archivo; recién después se registra OPAQUE con la Password U nueva y el backend retira el registro anterior.
import { sealKey, type KeyEnvelope } from '../../crypto/envelope.ts';
import type { Argon2, KdfParams } from '../../crypto/kdf.ts';
import { withKey } from '../../crypto/sign.ts';
import { zeroize } from '../../crypto/bytes.ts';
import type { StorageFlags, WalletApi } from '../../api/wallet-api.ts';
import { deriveForNewEnvelope } from '../../onboarding/user-key.ts';
import { registerOpaque } from '../../unlock/opaque.ts';
import type { UnlockedWallet } from '../../unlock/unlock.ts';

export interface ResealedKey {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
  authSecret: Uint8Array;
  kdf: KdfParams;
}

/** Paso 1: el sobre nuevo de la misma U (misma wallet, rol y versión; salt, nonce y K nuevos). */
export async function resealWithNewPassword(
  unlocked: UnlockedWallet,
  newPassword: string,
  argon2: Argon2,
  memoryKiB: number = unlocked.envelope.kdf.memoryKiB,
): Promise<ResealedKey> {
  const { encryptionKey, authSecret, kdf } = await deriveForNewEnvelope(newPassword, 'U', argon2, memoryKiB);
  if (authSecret === null) throw new Error('falta AuthSecret_U');
  const envelope = await withKey(unlocked.envelope, unlocked.encryptionKey, (key) =>
    sealKey(key, encryptionKey, unlocked.envelope, kdf),
  );
  return { envelope, encryptionKey, authSecret, kdf };
}

/** Paso 2 (después de los backups): registro OPAQUE nuevo con OPERATIONS; el anterior queda retirado. */
export async function commitNewPassword(
  api: WalletApi,
  unlocked: UnlockedWallet,
  resealed: ResealedKey,
  storageFlags: StorageFlags,
): Promise<UnlockedWallet> {
  const walletId = unlocked.envelope.walletId;
  try {
    const registrationRecord = await registerOpaque(resealed.authSecret, (registrationRequest) =>
      api.userKeyOpaqueRegistration(unlocked.platform, walletId, registrationRequest),
    );
    await api.changeUserKeyPassword(unlocked.platform, walletId, {
      registrationRecord,
      kdfParams: resealed.kdf,
      storageFlags,
    });
  } finally {
    zeroize(resealed.authSecret);
  }
  return { ...unlocked, envelope: resealed.envelope, encryptionKey: resealed.encryptionKey };
}
