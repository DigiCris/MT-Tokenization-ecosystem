// Alta de U en el onboarding ([F-KEY-01..06], P17.T05): U nueva (CSPRNG, escalar válido), Password U de 5 palabras,
// sobre cifrado con AAD de la wallet (Argon2id de 64 MiB o, como opción avanzada para computadoras, 128 MiB) y, una vez
// hechos los backups, registro OPAQUE (la entrada es AuthSecret_U, nunca la Password U) y alta de U en el backend
// (PENDING hasta que la Safe quede ACTIVE). U y la Password U nunca salen del navegador; el backend recibe la dirección,
// los parámetros públicos del KDF, qué backups se confirmaron y el registro.
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
import { ARGON2_BASELINE, ARGON2_DESKTOP_MEMORY_KIB } from '../workers/argon2-protocol.ts';

/** Versión de U en el onboarding (la primera de la wallet). */
export const ONBOARDING_KEY_VERSION = 1;

/**
 * Qué pasa si se pierden U y R a la vez (RR-14): la Safe es 2-de-3 y S sola nunca alcanza el umbral. Se muestra donde se
 * piden los backups y al activar Recovery. El U+2060 (word joiner) pega cada raya a la palabra de al lado, para que no
 * quede sola al final de un renglón (hallazgo N9).
 */
/**
 * Título de lo que se imprime o se anota de cada backup de U (hallazgo 7 de la tercera revisión de P17.MAN): una hoja
 * suelta tiene que decir de qué app y de qué clave es, y con qué se abre.
 */
export const U_WORDS_TITLE = 'MT Wallet: 17 palabras de tu clave U';

export function uQrTitle(part: number, parts: number): string {
  return `MT Wallet: QR del sobre de tu clave U, parte ${String(part)} de ${String(parts)} (se abre con la Password U)`;
}

/** Al anotar las 17 palabras a mano, el mismo título que sale impreso. */
export const U_WORDS_HANDWRITTEN = `Si las anotás a mano, escribí arriba de qué clave son: «${U_WORDS_TITLE}».`;

export const LOST_U_AND_R_WARNING =
  'Tu Safe necesita 2 de sus 3 firmas. Si perdés tu clave U (Password U y backups) y también tu clave R, nadie —\u2060tampoco MT Wallet\u2060— puede mover tus fondos: con la clave de la plataforma sola no alcanza. Por eso pedimos backups de las dos.';

/**
 * Memoria de Argon2id del sobre de U ([F-KEY-03]): el baseline de 64 MiB o, con la opción avanzada para computadoras
 * (desactivada por defecto), 128 MiB. Un sobre de 128 MiB puede no abrir en celulares.
 */
export function userKeyMemoryKiB(desktopOption: boolean): number {
  return desktopOption ? ARGON2_DESKTOP_MEMORY_KIB : ARGON2_BASELINE.memoryKiB;
}

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
