// Sobres cifrados `U.enc` y `R.enc` ([F-KEY-03]/[F-KEY-04], formato `mtw-key-envelope` v1, el mismo para U y R):
// Root = Argon2id(Password, salt, m, t, p, 32); K = HKDF-SHA256(Root, "mtw-hkdf-v1", "<rol>-encryption-v1");
// AES-256-GCM (ciphertext ‖ tag, base64url) con el AAD `mtw-key-envelope|1|plataforma|8453|wallet|rol|dirección|versión`.
// Implementación propia de la herramienta, verificada contra los vectores de contracts/; el texto plano tiene que ser
// la clave de la dirección declarada.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { base64UrlToBytes, bytesToHex, own, utf8, wipe } from './encoding.ts';

export type KeyRole = 'U' | 'R';

export interface KeyEnvelope {
  format: 'mtw-key-envelope';
  formatVersion: 1;
  platformId: string;
  chainId: 8453;
  walletId: string;
  role: KeyRole;
  keyAddress: Address;
  keyVersion: number;
  kdf: { alg: 'argon2id'; version: 19; memoryKiB: number; iterations: number; parallelism: number; salt: string };
  cipher: { alg: 'AES-256-GCM'; nonce: string };
  ciphertext: string;
}

export class EnvelopeError extends Error {
  override name = 'EnvelopeError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida la forma del sobre (archivo o QR) antes de usarlo. */
export function parseEnvelope(value: unknown): KeyEnvelope {
  if (!isRecord(value) || value.format !== 'mtw-key-envelope' || value.formatVersion !== 1) {
    throw new EnvelopeError('No es un sobre cifrado de MT Wallet (mtw-key-envelope v1).');
  }
  const { platformId, chainId, walletId, role, keyAddress, keyVersion, kdf, cipher, ciphertext } = value;
  if (chainId !== 8453) throw new EnvelopeError('El sobre no es de Base (8453).');
  if (role !== 'U' && role !== 'R') throw new EnvelopeError('El sobre no es de una clave U ni R.');
  if (typeof platformId !== 'string' || typeof walletId !== 'string' || walletId === '') {
    throw new EnvelopeError('El sobre no tiene plataforma o wallet.');
  }
  if (typeof keyAddress !== 'string' || !isAddress(keyAddress))
    throw new EnvelopeError('Dirección del sobre inválida.');
  if (typeof keyVersion !== 'number' || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new EnvelopeError('Versión de la clave inválida.');
  }
  if (
    !isRecord(kdf) ||
    kdf.alg !== 'argon2id' ||
    kdf.version !== 19 ||
    typeof kdf.memoryKiB !== 'number' ||
    typeof kdf.iterations !== 'number' ||
    typeof kdf.parallelism !== 'number' ||
    typeof kdf.salt !== 'string'
  ) {
    throw new EnvelopeError('Parámetros de Argon2id inválidos.');
  }
  // [F-KEY-03]: 64 MiB (o 128 MiB en dispositivos fuertes), t=3, p=4. Nada más: un sobre con otros parámetros (p. ej.
  // gigabytes de memoria) no se intenta abrir.
  if ((kdf.memoryKiB !== 65_536 && kdf.memoryKiB !== 131_072) || kdf.iterations !== 3 || kdf.parallelism !== 4) {
    throw new EnvelopeError('Parámetros de Argon2id fuera de los de MT Wallet.');
  }
  if (!isRecord(cipher) || cipher.alg !== 'AES-256-GCM' || typeof cipher.nonce !== 'string') {
    throw new EnvelopeError('Cifrado del sobre inválido.');
  }
  if (typeof ciphertext !== 'string') throw new EnvelopeError('Texto cifrado inválido.');
  base64UrlToBytes(kdf.salt, 16);
  base64UrlToBytes(cipher.nonce, 12);
  if (base64UrlToBytes(ciphertext).length !== 48) throw new EnvelopeError('El texto cifrado no es una clave cifrada.');
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
      memoryKiB: kdf.memoryKiB,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      salt: kdf.salt,
    },
    cipher: { alg: 'AES-256-GCM', nonce: cipher.nonce },
    ciphertext,
  };
}

export function envelopeAad(envelope: KeyEnvelope): string {
  return [
    'mtw-key-envelope',
    '1',
    envelope.platformId,
    String(envelope.chainId),
    envelope.walletId,
    envelope.role,
    envelope.keyAddress.toLowerCase(),
    String(envelope.keyVersion),
  ].join('|');
}

/** Lo que escribe el usuario → la forma que entra a Argon2id (minúsculas, un espacio entre palabras). */
export function normalizePassword(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export type Argon2 = (password: Uint8Array, salt: Uint8Array, params: KeyEnvelope['kdf']) => Promise<Uint8Array>;

export const nobleArgon2: Argon2 = (password, salt, params) =>
  argon2idAsync(password, salt, { m: params.memoryKiB, t: params.iterations, p: params.parallelism, dkLen: 32 });

/** K del sobre (AES-256-GCM no exportable) a partir de la Password. Borra Root. */
export async function encryptionKey(envelope: KeyEnvelope, password: string, argon2: Argon2 = nobleArgon2) {
  const root = await argon2(utf8(normalizePassword(password)), base64UrlToBytes(envelope.kdf.salt, 16), envelope.kdf);
  try {
    const base = await crypto.subtle.importKey('raw', own(root), 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: own(utf8('mtw-hkdf-v1')),
        info: own(utf8(`${envelope.role}-encryption-v1`)),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
  } finally {
    wipe(root);
  }
}

/** Abre el sobre: la clave de 32 bytes, que tiene que ser la de `keyAddress`. Password equivocada → error sin detalle. */
export async function openEnvelope(
  envelope: KeyEnvelope,
  password: string,
  argon2: Argon2 = nobleArgon2,
): Promise<Uint8Array> {
  const key = await encryptionKey(envelope, password, argon2);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: own(base64UrlToBytes(envelope.cipher.nonce, 12)),
          additionalData: own(utf8(envelopeAad(envelope))),
          tagLength: 128,
        },
        key,
        own(base64UrlToBytes(envelope.ciphertext)),
      ),
    );
  } catch {
    throw new EnvelopeError(`La Password ${envelope.role} no abre este sobre.`);
  }
  if (plain.length !== 32 || privateKeyToAddress(bytesToHex(plain)) !== envelope.keyAddress) {
    wipe(plain);
    throw new EnvelopeError('El sobre no contiene la clave de su dirección: no se usa.');
  }
  return plain;
}
