// Sobre cifrado de una clave ([F-KEY-04]): JSON `mtw-key-envelope` v1 con los parámetros de Argon2id y AES-256-GCM
// (nonce de 12 bytes nuevo por cifrado; ciphertext ‖ tag de 16 bytes en base64url). AAD = UTF-8 de
// `mtw-key-envelope|1|{platformId}|{chainId}|{walletId}|{role}|{keyAddress en minúsculas}|{keyVersion}`: mover el sobre a
// otra wallet, rol o versión hace fallar el descifrado. Después de descifrar se verifica que la dirección derivada sea la
// del sobre. Nunca se guarda la clave en claro; el sobre sí se puede subir a Drive, descargar o mostrar como QR.
import { getAddress, type Address } from 'viem';
import { validateArgon2 } from '../workers/argon2-protocol.ts';
import { fromBase64Url, ownBuffer, randomBytes, toBase64Url, utf8, zeroize } from './bytes.ts';
import { deriveKeys, type Argon2, type DerivedKeys, type KdfParams, type KeyRole } from './kdf.ts';
import { addressOf, isValidPrivateKey } from './keys.ts';

export interface EnvelopeMeta {
  platformId: string;
  chainId: number;
  walletId: string;
  role: KeyRole;
  keyAddress: Address;
  keyVersion: number;
}

export interface KeyEnvelope extends EnvelopeMeta {
  format: 'mtw-key-envelope';
  formatVersion: 1;
  kdf: KdfParams;
  cipher: { alg: 'AES-256-GCM'; nonce: string };
  ciphertext: string;
  createdAt: string;
}

export class EnvelopeError extends Error {
  override name = 'EnvelopeError';
}

export function envelopeAad(meta: EnvelopeMeta): string {
  return [
    'mtw-key-envelope',
    '1',
    meta.platformId,
    String(meta.chainId),
    meta.walletId,
    meta.role,
    meta.keyAddress.toLowerCase(),
    String(meta.keyVersion),
  ].join('|');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida la forma completa de un sobre leído de un archivo, de Drive o de un QR. */
export function parseEnvelope(value: unknown): KeyEnvelope {
  if (!isRecord(value) || value.format !== 'mtw-key-envelope' || value.formatVersion !== 1) {
    throw new EnvelopeError('no es un sobre de MT Wallet (formato desconocido)');
  }
  const { platformId, chainId, walletId, role, keyAddress, keyVersion, kdf, cipher, ciphertext, createdAt } = value;
  if (typeof platformId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(platformId))
    throw new EnvelopeError('platformId inválido');
  if (chainId !== 8453) throw new EnvelopeError('el sobre no es de Base (8453)');
  if (typeof walletId !== 'string' || !/^[0-9a-f-]{36}$/.test(walletId)) throw new EnvelopeError('walletId inválido');
  if (role !== 'U' && role !== 'R') throw new EnvelopeError('rol inválido');
  if (typeof keyAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(keyAddress))
    throw new EnvelopeError('dirección inválida');
  if (typeof keyVersion !== 'number' || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new EnvelopeError('versión de clave inválida');
  }
  if (!isRecord(kdf) || kdf.alg !== 'argon2id' || kdf.version !== 19 || typeof kdf.salt !== 'string') {
    throw new EnvelopeError('parámetros de derivación inválidos');
  }
  const params = {
    memoryKiB: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    outputLength: 32,
  };
  const salt = fromBase64Url(kdf.salt);
  validateArgon2(params as { memoryKiB: number; iterations: number; parallelism: number; outputLength: number }, salt);
  if (salt.length !== 16) throw new EnvelopeError('salt inválido');
  if (!isRecord(cipher) || cipher.alg !== 'AES-256-GCM' || typeof cipher.nonce !== 'string') {
    throw new EnvelopeError('cifrado inválido');
  }
  if (fromBase64Url(cipher.nonce).length !== 12) throw new EnvelopeError('nonce inválido');
  if (typeof ciphertext !== 'string' || fromBase64Url(ciphertext).length !== 48)
    throw new EnvelopeError('ciphertext inválido');
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new EnvelopeError('fecha inválida');
  return {
    format: 'mtw-key-envelope',
    formatVersion: 1,
    platformId,
    chainId: 8453,
    walletId,
    role,
    keyAddress: getAddress(keyAddress),
    keyVersion,
    kdf: {
      alg: 'argon2id',
      version: 19,
      memoryKiB: kdf.memoryKiB as number,
      iterations: kdf.iterations as number,
      parallelism: kdf.parallelism as number,
      salt: kdf.salt,
    },
    cipher: { alg: 'AES-256-GCM', nonce: cipher.nonce },
    ciphertext,
    createdAt,
  };
}

/** Serialización con el orden de campos del formato: es lo que se sube y se verifica byte a byte después. */
export function serializeEnvelope(envelope: KeyEnvelope): string {
  const ordered: KeyEnvelope = {
    format: envelope.format,
    formatVersion: envelope.formatVersion,
    platformId: envelope.platformId,
    chainId: envelope.chainId,
    walletId: envelope.walletId,
    role: envelope.role,
    keyAddress: envelope.keyAddress,
    keyVersion: envelope.keyVersion,
    kdf: {
      alg: envelope.kdf.alg,
      version: envelope.kdf.version,
      memoryKiB: envelope.kdf.memoryKiB,
      iterations: envelope.kdf.iterations,
      parallelism: envelope.kdf.parallelism,
      salt: envelope.kdf.salt,
    },
    cipher: { alg: envelope.cipher.alg, nonce: envelope.cipher.nonce },
    ciphertext: envelope.ciphertext,
    createdAt: envelope.createdAt,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Cifra la clave con K (ya derivada) y arma el sobre. `nonce` y `createdAt` sólo se fijan en tests. */
export async function sealKey(
  key: Uint8Array,
  encryptionKey: CryptoKey,
  meta: EnvelopeMeta,
  kdf: KdfParams,
  options: { nonce?: Uint8Array; createdAt?: string } = {},
): Promise<KeyEnvelope> {
  if (!isValidPrivateKey(key) || addressOf(key) !== getAddress(meta.keyAddress)) {
    throw new EnvelopeError('la clave no corresponde a la dirección del sobre');
  }
  const nonce = options.nonce ?? randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownBuffer(nonce), additionalData: ownBuffer(utf8(envelopeAad(meta))), tagLength: 128 },
    encryptionKey,
    ownBuffer(key),
  );
  return {
    format: 'mtw-key-envelope',
    formatVersion: 1,
    platformId: meta.platformId,
    chainId: meta.chainId,
    walletId: meta.walletId,
    role: meta.role,
    keyAddress: getAddress(meta.keyAddress),
    keyVersion: meta.keyVersion,
    kdf,
    cipher: { alg: 'AES-256-GCM', nonce: toBase64Url(nonce) },
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    createdAt: options.createdAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * Descifra la clave del sobre con K. Un ciphertext, nonce o AAD alterado falla igual que una password equivocada (sin
 * oráculo); si la dirección derivada no es la del sobre, la clave se borra y falla.
 */
export async function openEnvelope(envelope: KeyEnvelope, encryptionKey: CryptoKey): Promise<Uint8Array> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: ownBuffer(fromBase64Url(envelope.cipher.nonce)),
          additionalData: ownBuffer(utf8(envelopeAad(envelope))),
          tagLength: 128,
        },
        encryptionKey,
        ownBuffer(fromBase64Url(envelope.ciphertext)),
      ),
    );
  } catch {
    throw new EnvelopeError('no se pudo abrir el sobre: password incorrecta o sobre alterado');
  }
  if (!isValidPrivateKey(plain) || addressOf(plain) !== envelope.keyAddress) {
    zeroize(plain);
    throw new EnvelopeError('la clave del sobre no corresponde a su dirección');
  }
  return plain;
}

/** Deriva K (y AuthSecret_U) de la password con los parámetros del sobre. */
export async function keysForEnvelope(envelope: KeyEnvelope, password: string, argon2: Argon2): Promise<DerivedKeys> {
  return deriveKeys(password, envelope.role, envelope.kdf, fromBase64Url(envelope.kdf.salt), argon2);
}
