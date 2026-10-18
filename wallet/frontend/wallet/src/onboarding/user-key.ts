// Alta de U en el onboarding ([F-KEY-01..06], P17.T05): U nueva (CSPRNG, escalar válido), Password U de 5 palabras,
// sobre cifrado con AAD de la wallet y, una vez hechos los backups, registro OPAQUE (la entrada es AuthSecret_U, nunca la
// Password U) y alta de U en el backend (PENDING hasta que la Safe quede ACTIVE). U y la Password U nunca salen del
// navegador; el backend recibe la dirección, los parámetros públicos del KDF, qué backups se confirmaron y el registro.
import type { Address } from 'viem';
import { randomBytes, toBase64Url, zeroize } from '../crypto/bytes.ts';
import { sealKey, type KeyEnvelope } from '../crypto/envelope.ts';
import { defaultKdfParams, deriveKeys, type Argon2, type KdfParams, type KeyRole } from '../crypto/kdf.ts';
import { addressOf, generatePrivateKey } from '../crypto/keys.ts';
import { generatePassword } from '../crypto/password.ts';
import type { Wordlist } from '../crypto/wordlist.ts';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { StorageFlags, WalletApi } from '../api/wallet-api.ts';
import { registerOpaque } from '../unlock/opaque.ts';

/** Versión de U en el onboarding (la primera de la wallet). */
export const ONBOARDING_KEY_VERSION = 1;

export interface DraftKey {
  key: Uint8Array;
  address: Address;
  passwordWords: string[];
}

export function draftUserKey(wordlist: Wordlist): DraftKey {
  const key = generatePrivateKey();
  return { key, address: addressOf(key), passwordWords: generatePassword(wordlist) };
}

export interface SealedKey {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
  /** AuthSecret_U: se borra después de registrar OPAQUE. */
  authSecret: Uint8Array;
  kdf: KdfParams;
}

/** Deriva K_U y AuthSecret_U de la Password U con salt nuevo (sin sellar todavía: la versión puede venir del backend). */
export async function deriveForNewEnvelope(
  password: string,
  role: KeyRole,
  argon2: Argon2,
  memoryKiB?: number,
): Promise<{ encryptionKey: CryptoKey; authSecret: Uint8Array | null; kdf: KdfParams }> {
  const salt = randomBytes(16);
  const kdf = defaultKdfParams(toBase64Url(salt), memoryKiB);
  const keys = await deriveKeys(password, role, kdf, salt, argon2);
  return { ...keys, kdf };
}

export async function sealUserKey(
  draft: { key: Uint8Array; address: Address },
  password: string,
  meta: { platformId: string; walletId: string; keyVersion: number },
  argon2: Argon2,
  memoryKiB?: number,
): Promise<SealedKey> {
  const { encryptionKey, authSecret, kdf } = await deriveForNewEnvelope(password, 'U', argon2, memoryKiB);
  if (authSecret === null) throw new Error('falta AuthSecret_U');
  const envelope = await sealKey(
    draft.key,
    encryptionKey,
    {
      platformId: meta.platformId,
      chainId: 8453,
      walletId: meta.walletId,
      role: 'U',
      keyAddress: draft.address,
      keyVersion: meta.keyVersion,
    },
    kdf,
  );
  return { envelope, encryptionKey, authSecret, kdf };
}

/** Registro OPAQUE + alta de U con ONBOARDING (después de los backups). Borra AuthSecret_U al terminar. */
export async function registerNewUserKey(
  api: WalletApi,
  platform: PlatformAuth,
  sealed: SealedKey,
  storageFlags: StorageFlags,
): Promise<{ userKey: Address; keyVersion: number; status: 'PENDING' }> {
  const walletId = sealed.envelope.walletId;
  try {
    const registrationRecord = await registerOpaque(sealed.authSecret, (registrationRequest) =>
      api.userKeyOpaqueRegistration(platform, walletId, registrationRequest),
    );
    return await api.registerUserKey(platform, walletId, {
      userKey: sealed.envelope.keyAddress,
      kdfParams: sealed.kdf,
      storageFlags,
      registrationRecord,
    });
  } finally {
    zeroize(sealed.authSecret);
  }
}

/** [F-KEY-06]: antes de seguir hace falta al menos un backup que no dependa de la plataforma. */
export function hasIndependentBackup(flags: StorageFlags): boolean {
  return flags.file || flags.qr || flags.words;
}
