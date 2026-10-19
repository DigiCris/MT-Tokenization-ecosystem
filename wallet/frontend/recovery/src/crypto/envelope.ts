// Sobre cifrado de R ([F-KEY-04], `R.enc`): JSON `mtw-key-envelope` v1 con role "R" y los parámetros de Argon2id, el
// nonce de AES-256-GCM (nuevo por cifrado) y el ciphertext ‖ tag. AAD = UTF-8 de
// `mtw-key-envelope|1|{platformId}|{chainId}|{walletId}|R|{keyAddress en minúsculas}|{keyVersion}`: un sobre movido a
// otra wallet, plataforma o versión no abre. Tras descifrar se exige que la dirección derivada sea `keyAddress`.
// Abrir el sobre devuelve K_R como CryptoKey no exportable; R se descifra sólo para cada firma (session.ts).
import { getAddress, isAddress, type Address } from 'viem';
import { ARGON2_BASELINE, validateArgon2 } from '../workers/argon2-protocol.ts';
import { base64UrlToBytes, bytesToBase64Url, toBufferSource, utf8, wipe } from './encoding.ts';
import { deriveRoot, encryptionKeyFromRoot, R_KDF, type Argon2, type KdfParams } from './kdf.ts';
import { addressOfKey, randomBytes, type RandomBytes } from './secp256k1.ts';

export const ENVELOPE_FORMAT = 'mtw-key-envelope';
export const ENVELOPE_VERSION = 1;
export const BASE_CHAIN_ID = 8453;

export interface RecoveryEnvelope {
  format: typeof ENVELOPE_FORMAT;
  formatVersion: typeof ENVELOPE_VERSION;
  platformId: string;
  chainId: typeof BASE_CHAIN_ID;
  walletId: string;
  role: 'R';
  keyAddress: Address;
  keyVersion: number;
  kdf: { alg: 'argon2id'; version: 19; memoryKiB: number; iterations: number; parallelism: number; salt: string };
  cipher: { alg: 'AES-256-GCM'; nonce: string };
  ciphertext: string;
  createdAt: string;
}

export interface EnvelopeContext {
  platformId: string;
  walletId: string;
  keyVersion: number;
}

export class EnvelopeError extends Error {
  override name = 'EnvelopeError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORM_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extra.length > 0 || missing.length > 0) throw new EnvelopeError(`${what}: campos inesperados o faltantes`);
}

/** Valida un sobre de R leído de un archivo, de un QR o de Drive (estricto: un campo de más o de menos no se acepta). */
export function parseRecoveryEnvelope(value: unknown): RecoveryEnvelope {
  if (!isRecord(value)) throw new EnvelopeError('el sobre no es un objeto JSON');
  exactKeys(
    value,
    [
      'format',
      'formatVersion',
      'platformId',
      'chainId',
      'walletId',
      'role',
      'keyAddress',
      'keyVersion',
      'kdf',
      'cipher',
      'ciphertext',
      'createdAt',
    ],
    'sobre',
  );
  const { format, formatVersion, platformId, chainId, walletId, role, keyAddress, keyVersion, kdf, cipher } = value;
  if (format !== ENVELOPE_FORMAT || formatVersion !== ENVELOPE_VERSION) {
    throw new EnvelopeError('no es un sobre mtw-key-envelope v1');
  }
  if (role !== 'R') throw new EnvelopeError('el sobre no es de una clave R (la app Recovery sólo abre R)');
  if (chainId !== BASE_CHAIN_ID) throw new EnvelopeError('el sobre no es de Base (8453)');
  if (typeof platformId !== 'string' || !PLATFORM_ID.test(platformId)) throw new EnvelopeError('platformId inválido');
  if (typeof walletId !== 'string' || !UUID.test(walletId)) throw new EnvelopeError('walletId inválido');
  if (
    typeof keyAddress !== 'string' ||
    !isAddress(keyAddress, { strict: true }) ||
    keyAddress !== getAddress(keyAddress)
  ) {
    throw new EnvelopeError('keyAddress inválida (EIP-55)');
  }
  if (typeof keyVersion !== 'number' || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new EnvelopeError('keyVersion inválido');
  }
  if (!isRecord(kdf)) throw new EnvelopeError('kdf inválido');
  exactKeys(kdf, ['alg', 'version', 'memoryKiB', 'iterations', 'parallelism', 'salt'], 'kdf');
  if (kdf.alg !== 'argon2id' || kdf.version !== 19) throw new EnvelopeError('el sobre no usa Argon2id v19');
  const salt = typeof kdf.salt === 'string' ? decode(kdf.salt, 16, 'salt') : null;
  if (salt === null) throw new EnvelopeError('salt inválido');
  const params = {
    memoryKiB: kdf.memoryKiB as number,
    iterations: kdf.iterations as number,
    parallelism: kdf.parallelism as number,
    outputLength: 32,
  };
  try {
    validateArgon2(params, salt);
  } catch (error) {
    throw new EnvelopeError(`parámetros de Argon2id inaceptables: ${(error as Error).message}`);
  }
  if (!isRecord(cipher)) throw new EnvelopeError('cipher inválido');
  exactKeys(cipher, ['alg', 'nonce'], 'cipher');
  if (cipher.alg !== 'AES-256-GCM' || typeof cipher.nonce !== 'string') throw new EnvelopeError('cifrado inválido');
  decode(cipher.nonce, 12, 'nonce');
  if (typeof value.ciphertext !== 'string') throw new EnvelopeError('ciphertext inválido');
  decode(value.ciphertext, 48, 'ciphertext');
  if (typeof value.createdAt !== 'string' || !ISO_SECONDS.test(value.createdAt)) {
    throw new EnvelopeError('createdAt inválido');
  }
  return value as unknown as RecoveryEnvelope;
}

function decode(text: string, length: number, what: string): Uint8Array {
  try {
    return base64UrlToBytes(text, length);
  } catch {
    throw new EnvelopeError(`${what} inválido`);
  }
}

export function envelopeAad(
  envelope: Pick<RecoveryEnvelope, 'platformId' | 'chainId' | 'walletId' | 'role' | 'keyAddress' | 'keyVersion'>,
): string {
  return [
    ENVELOPE_FORMAT,
    String(ENVELOPE_VERSION),
    envelope.platformId,
    String(envelope.chainId),
    envelope.walletId,
    envelope.role,
    envelope.keyAddress.toLowerCase(),
    String(envelope.keyVersion),
  ].join('|');
}

function gcm(envelope: RecoveryEnvelope): AesGcmParams {
  return {
    name: 'AES-GCM',
    iv: toBufferSource(base64UrlToBytes(envelope.cipher.nonce, 12)),
    additionalData: toBufferSource(utf8(envelopeAad(envelope))),
    tagLength: 128,
  };
}

export class WrongPasswordError extends EnvelopeError {
  override name = 'WrongPasswordError';
}

/** Descifra R con K_R (la usa session.ts para cada firma): quien la recibe la tiene que borrar. */
export async function decryptRecoveryKey(envelope: RecoveryEnvelope, encryptionKey: CryptoKey): Promise<Uint8Array> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        gcm(envelope),
        encryptionKey,
        toBufferSource(base64UrlToBytes(envelope.ciphertext, 48)),
      ),
    );
  } catch {
    throw new WrongPasswordError('La Password R no abre este sobre (o el sobre fue modificado).');
  }
  try {
    if (addressOfKey(plain) !== envelope.keyAddress)
      throw new EnvelopeError('la clave del sobre no es la de keyAddress');
  } catch (error) {
    wipe(plain);
    throw error instanceof EnvelopeError ? error : new EnvelopeError('el sobre contiene una clave inválida');
  }
  return plain;
}

export interface OpenedEnvelope {
  envelope: RecoveryEnvelope;
  /** K_R no exportable: abre el sobre para cada firma. */
  encryptionKey: CryptoKey;
  address: Address;
}

/** Abre el sobre con la Password R (ya normalizada): deriva K_R, verifica que descifra a keyAddress y borra R. */
export async function openRecoveryEnvelope(
  envelope: RecoveryEnvelope,
  password: string,
  argon2: Argon2,
): Promise<OpenedEnvelope> {
  const params: KdfParams = {
    memoryKiB: envelope.kdf.memoryKiB,
    iterations: envelope.kdf.iterations,
    parallelism: envelope.kdf.parallelism,
  };
  const root = await deriveRoot(password, base64UrlToBytes(envelope.kdf.salt, 16), params, argon2);
  const encryptionKey = await encryptionKeyFromRoot(root);
  wipe(await decryptRecoveryKey(envelope, encryptionKey));
  return { envelope, encryptionKey, address: envelope.keyAddress };
}

/** Sella R con una Password R para esa wallet: salt y nonce nuevos, baseline de V9 (64 MiB). No borra `key`. */
export async function sealRecoveryKey(
  key: Uint8Array,
  password: string,
  context: EnvelopeContext,
  argon2: Argon2,
  options: { random?: RandomBytes; now?: Date } = {},
): Promise<OpenedEnvelope> {
  const random = options.random ?? randomBytes;
  const salt = random(16);
  const nonce = random(12);
  const keyAddress = addressOfKey(key);
  const root = await deriveRoot(password, salt, R_KDF, argon2);
  const encryptionKey = await encryptionKeyFromRoot(root);
  const header = {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    platformId: context.platformId,
    chainId: BASE_CHAIN_ID,
    walletId: context.walletId,
    role: 'R',
    keyAddress,
    keyVersion: context.keyVersion,
    kdf: {
      alg: 'argon2id',
      version: 19,
      memoryKiB: R_KDF.memoryKiB,
      iterations: R_KDF.iterations,
      parallelism: R_KDF.parallelism,
      salt: bytesToBase64Url(salt),
    },
    cipher: { alg: 'AES-256-GCM', nonce: bytesToBase64Url(nonce) },
    ciphertext: '',
    createdAt: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  } satisfies RecoveryEnvelope;
  const plain = toBufferSource(key);
  try {
    const sealed = new Uint8Array(await crypto.subtle.encrypt(gcm(header), encryptionKey, plain));
    const envelope = parseRecoveryEnvelope({ ...header, ciphertext: bytesToBase64Url(sealed) });
    return { envelope, encryptionKey, address: keyAddress };
  } finally {
    wipe(plain);
  }
}

/** El archivo descargable (`mtw-R-<walletId>.enc.json`) y el contenido del QR: el JSON del sobre. */
export function serializeRecoveryEnvelope(envelope: RecoveryEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function envelopeFileName(envelope: Pick<RecoveryEnvelope, 'walletId'>): string {
  return `mtw-R-${envelope.walletId}.enc.json`;
}

/** Baseline de Argon2id de la app (para la UI del dispositivo). */
export const RECOVERY_ARGON2 = ARGON2_BASELINE;
