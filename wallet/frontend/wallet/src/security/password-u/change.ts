// Cambio de Password U [F-KEY-08] (P17.T07): con la wallet desbloqueada (PlatformSession OPERATIONS), U se descifra con
// K_U sólo para re-cifrarla con salt y Password U nuevos (U no cambia); la UI sube el sobre nuevo a Drive y ofrece el
// archivo; recién después se registra OPAQUE con la Password U nueva y el backend retira el registro anterior. Un
// intento que falla (red, 5xx, 429) se puede reintentar: cada uno usa una copia de AuthSecret_U, que se borra al
// terminarlo, y el original se borra recién al registrarse bien (o al salir de la pantalla). Si no, el reintento
// registraría OPAQUE con el secreto en cero y la Password U nueva no desbloquearía (N1 de la verificación de P17.MAN).
import { sealKey, type KeyEnvelope } from '../../crypto/envelope.ts';
import type { Argon2, KdfParams } from '../../crypto/kdf.ts';
import { withKey } from '../../crypto/sign.ts';
import { zeroize } from '../../crypto/bytes.ts';
import type { StorageFlags, WalletApi } from '../../api/wallet-api.ts';
import { deriveForNewEnvelope } from '../../onboarding/user-key.ts';
import { registerOpaque } from '../../unlock/opaque.ts';
import type { UnlockedWallet } from '../../unlock/unlock.ts';

/**
 * La wallet se bloqueó (inactividad, vencimiento o «Bloquear») antes de registrar la Password U nueva: la plataforma
 * sigue con la anterior. Los backups de la nueva abren la clave, pero con ellos no se inicia la sesión de operaciones, y
 * el archivo, el QR y el papel tienen el mismo nombre y rótulo que los de la vigente (son de la misma U): hay que
 * destruirlos ya, porque después no se distinguen (N7 de la verificación de P17.MAN).
 */
export const CHANGE_INTERRUPTED_TEXT =
  'La wallet se bloqueó antes de registrar la Password U nueva, así que sigue valiendo la anterior: desbloqueá con ella y empezá el cambio de nuevo (vas a tener otra Password U nueva). Destruí ahora el papel de esa Password U nueva y el archivo y el QR que bajaste en este cambio: tienen el mismo nombre y rótulo que los de la vigente. La copia de Drive, si la subiste, reemplazala con la del cambio nuevo.';

/**
 * La Password U nueva ya quedó registrada, pero este dispositivo no pudo reemplazar el sobre que tenía guardado: ese
 * abre con la anterior, que ya no inicia la sesión de operaciones.
 */
export const REMEMBERED_NOT_REPLACED_TEXT =
  'Este dispositivo no pudo reemplazar el sobre que tenía guardado por el nuevo: para desbloquear, no uses «Usar el sobre guardado en este dispositivo»; traé el sobre nuevo desde Drive, desde el archivo o desde el QR de este cambio.';

export interface ResealedKey {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
  /** AuthSecret_U de la Password U nueva: se borra al registrarse bien (commitNewPassword) o al salir de la pantalla. */
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

/**
 * Paso 2 (después de los backups): registro OPAQUE nuevo con OPERATIONS; el anterior queda retirado. El intento usa una
 * copia de AuthSecret_U (se borra al terminar, salga bien o mal); el original se borra sólo si el cambio se registró.
 */
export async function commitNewPassword(
  api: WalletApi,
  unlocked: UnlockedWallet,
  resealed: ResealedKey,
  storageFlags: StorageFlags,
): Promise<UnlockedWallet> {
  const walletId = unlocked.envelope.walletId;
  const attempt = resealed.authSecret.slice();
  try {
    const registrationRecord = await registerOpaque(attempt, (registrationRequest) =>
      api.userKeyOpaqueRegistration(unlocked.platform, walletId, registrationRequest),
    );
    await api.changeUserKeyPassword(unlocked.platform, walletId, {
      registrationRecord,
      kdfParams: resealed.kdf,
      storageFlags,
    });
  } finally {
    zeroize(attempt);
  }
  zeroize(resealed.authSecret);
  return { ...unlocked, envelope: resealed.envelope, encryptionKey: resealed.encryptionKey };
}
