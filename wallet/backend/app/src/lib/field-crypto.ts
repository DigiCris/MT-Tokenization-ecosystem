// Cifrado de campos sensibles con APP_FIELD_ENCRYPTION_KEY (AES-256-GCM, IV aleatorio de 96 bits, tag de 128 bits).
// El AAD ata el ciphertext a su contexto (p. ej. el userId del secreto TOTP [B-AUTH-09]): copiarlo a otra fila no
// descifra. Formato: versión (1 byte) ‖ IV (12) ‖ tag (16) ‖ ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Secret } from '../config/secret.ts';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class FieldDecryptionError extends Error {
  override name = 'FieldDecryptionError';
}

export function encryptField(key: Secret<Buffer>, plaintext: Buffer | string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.reveal(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptField(key: Secret<Buffer>, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
    throw new FieldDecryptionError('formato inválido');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.reveal(), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new FieldDecryptionError('no se pudo descifrar (clave, contexto o contenido alterados)');
  }
}
