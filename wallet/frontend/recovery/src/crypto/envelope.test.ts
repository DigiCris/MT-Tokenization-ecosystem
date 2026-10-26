// P19.T02 [F-KEY-03]/[F-KEY-04]: el sobre de R contra el vector copiado de contracts/ (Argon2id real de la app en el
// hilo de los tests: Root_R, K_R, AAD y la clave de la etiqueta), y su comportamiento con un Argon2id de prueba rápido
// (sellar y abrir, Password R equivocada, sobre movido de wallet, clave que no es keyAddress, campos inesperados).
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import envelopeVectors from '../../test/vectors/wire/envelope.json' with { type: 'json' };
import { deriveArgon2id } from '../workers/argon2-protocol.ts';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, toBufferSource, utf8 } from './encoding.ts';
import {
  decryptRecoveryKey,
  envelopeAad,
  envelopeFileName,
  EnvelopeError,
  openRecoveryEnvelope,
  parseRecoveryEnvelope,
  sealRecoveryKey,
  serializeRecoveryEnvelope,
  WrongPasswordError,
  type RecoveryEnvelope,
} from './envelope.ts';
import { deriveRoot, encryptionKeyBytesForVectors, type Argon2 } from './kdf.ts';
import { addressOfKey, newPrivateKey } from './secp256k1.ts';

const vector = envelopeVectors.envelopes.find((e) => e.envelope.role === 'R');
if (!vector) throw new Error('el vector de sobres no tiene el de R');
const R_KEY = toBytes(keccak256(toBytes(vector.keyLabel)));

/** El Argon2id de la app (el mismo código que corre en el worker). */
const realArgon2: Argon2 = (input) => deriveArgon2id(input);

/** Argon2id de prueba: determinístico y rápido, para probar el sobre sin pagar 64 MiB por caso. */
const fastArgon2: Argon2 = async ({ password, salt }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));

const context = { platformId: 'mtw', walletId: '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5', keyVersion: 1 };

describe('vector de R (contracts/test/vectors/wire/envelope.json)', () => {
  it('Root_R, K_R, AAD y la clave: la app abre el sobre del vector con su Password R', async () => {
    const envelope = parseRecoveryEnvelope(vector.envelope);
    expect(envelopeAad(envelope)).toBe(vector.aad);
    const salt = base64UrlToBytes(envelope.kdf.salt, 16);
    const root = await deriveRoot(vector.password, salt, envelope.kdf, realArgon2);
    expect(bytesToHex(root)).toBe(vector.rootHex);
    expect(bytesToHex(await encryptionKeyBytesForVectors(root))).toBe(vector.encryptionKeyHex);
    const opened = await openRecoveryEnvelope(envelope, vector.password, realArgon2);
    expect(opened.address).toBe(addressOfKey(R_KEY));
    expect(await decryptRecoveryKey(envelope, opened.encryptionKey)).toEqual(R_KEY);
    await expect(crypto.subtle.exportKey('raw', opened.encryptionKey)).rejects.toThrow();
  });

  it('el sobre de U del mismo vector no se abre en Recovery', () => {
    const userEnvelope = envelopeVectors.envelopes.find((e) => e.envelope.role === 'U')?.envelope;
    expect(() => parseRecoveryEnvelope(userEnvelope)).toThrow('no es de una clave R');
  });
});

describe('sellar y abrir', () => {
  it('ida y vuelta con salt y nonce nuevos; el archivo es el JSON del sobre', async () => {
    const key = newPrivateKey();
    const sealed = await sealRecoveryKey(key, 'una password de prueba', context, fastArgon2, {
      now: new Date('2026-10-18T12:34:56.789Z'),
    });
    expect(sealed.envelope).toMatchObject({
      format: 'mtw-key-envelope',
      formatVersion: 1,
      role: 'R',
      chainId: 8453,
      keyAddress: addressOfKey(key),
      kdf: { alg: 'argon2id', version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 4 },
      createdAt: '2026-10-18T12:34:56Z',
    });
    const again = await sealRecoveryKey(key, 'una password de prueba', context, fastArgon2);
    expect(again.envelope.kdf.salt).not.toBe(sealed.envelope.kdf.salt);
    expect(again.envelope.cipher.nonce).not.toBe(sealed.envelope.cipher.nonce);
    const file = serializeRecoveryEnvelope(sealed.envelope);
    // El nombre lleva el principio y el final de la dirección de R: dos R de la misma wallet no bajan con el mismo.
    const hex = sealed.envelope.keyAddress.slice(2);
    expect(envelopeFileName(sealed.envelope)).toBe(
      `mtw-R-${context.walletId}-${hex.slice(0, 4)}-${hex.slice(-4)}.enc.json`,
    );
    expect(
      envelopeFileName({
        walletId: context.walletId,
        keyAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      }),
    ).toBe(`mtw-R-${context.walletId}-8335-2913.enc.json`);
    const reopened = await openRecoveryEnvelope(
      parseRecoveryEnvelope(JSON.parse(file)),
      'una password de prueba',
      fastArgon2,
    );
    expect(await decryptRecoveryKey(reopened.envelope, reopened.encryptionKey)).toEqual(key);
  });

  it('una Password R equivocada no abre el sobre', async () => {
    const sealed = await sealRecoveryKey(newPrivateKey(), 'la buena', context, fastArgon2);
    await expect(openRecoveryEnvelope(sealed.envelope, 'la mala', fastArgon2)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('el AAD ata el sobre a su wallet, plataforma, dirección y versión: cambiado cualquiera, no descifra', async () => {
    const sealed = await sealRecoveryKey(newPrivateKey(), 'pw', context, fastArgon2);
    const other = addressOfKey(newPrivateKey());
    for (const change of [
      { walletId: '00000000-0000-4000-8000-000000000000' },
      { platformId: 'otra' },
      { keyVersion: 2 },
      { keyAddress: other },
    ] satisfies Partial<RecoveryEnvelope>[]) {
      const moved = parseRecoveryEnvelope({ ...sealed.envelope, ...change });
      await expect(decryptRecoveryKey(moved, sealed.encryptionKey)).rejects.toThrow(EnvelopeError);
    }
  });

  it('un sobre que descifra a otra clave que keyAddress se rechaza', async () => {
    // Un sobre armado a mano: AAD y keyAddress de una dirección, ciphertext de otra clave, con la misma K_R.
    const keyA = newPrivateKey();
    const keyB = newPrivateKey();
    const sealedA = await sealRecoveryKey(keyA, 'pw', context, fastArgon2);
    const root = await fastArgon2({
      password: utf8('pw'),
      salt: base64UrlToBytes(sealedA.envelope.kdf.salt, 16),
      memoryKiB: 65_536,
      iterations: 3,
      parallelism: 4,
      outputLength: 32,
    });
    const raw = await encryptionKeyBytesForVectors(root);
    const k = await crypto.subtle.importKey('raw', toBufferSource(raw), 'AES-GCM', false, ['encrypt']);
    const forged = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(base64UrlToBytes(sealedA.envelope.cipher.nonce, 12)),
          additionalData: toBufferSource(utf8(envelopeAad(sealedA.envelope))),
        },
        k,
        toBufferSource(keyB),
      ),
    );
    const envelope = parseRecoveryEnvelope({ ...sealedA.envelope, ciphertext: bytesToBase64Url(forged) });
    await expect(decryptRecoveryKey(envelope, sealedA.encryptionKey)).rejects.toThrow('no es la de keyAddress');
  });
});

describe('validación estricta del JSON', () => {
  const valid = vector.envelope;

  it('rechaza campos de más o de menos, versiones y algoritmos ajenos, y valores mal formados', () => {
    const cases: [unknown, string][] = [
      [null, 'no es un objeto'],
      [{ ...valid, extra: 1 }, 'campos inesperados'],
      [{ ...valid, formatVersion: 2 }, 'v1'],
      [{ ...valid, chainId: 1 }, 'Base'],
      [{ ...valid, platformId: 'MTW' }, 'platformId'],
      [{ ...valid, walletId: 'no-uuid' }, 'walletId'],
      [{ ...valid, keyAddress: valid.keyAddress.toLowerCase() }, 'EIP-55'],
      [{ ...valid, keyVersion: 0 }, 'keyVersion'],
      [{ ...valid, kdf: { ...valid.kdf, alg: 'scrypt' } }, 'Argon2id'],
      [{ ...valid, kdf: { ...valid.kdf, memoryKiB: 1_048_576 } }, 'Argon2id inaceptables'],
      [{ ...valid, kdf: { ...valid.kdf, salt: 'corto' } }, 'salt'],
      [{ ...valid, cipher: { ...valid.cipher, alg: 'AES-128-GCM' } }, 'cifrado'],
      [{ ...valid, cipher: { ...valid.cipher, nonce: 'AAAA' } }, 'nonce'],
      [{ ...valid, ciphertext: 'AAAA' }, 'ciphertext'],
      [{ ...valid, createdAt: '2026-10-17T12:00:00.000Z' }, 'createdAt'],
    ];
    for (const [value, message] of cases) expect(() => parseRecoveryEnvelope(value), message).toThrow(message);
    expect(parseRecoveryEnvelope(valid)).toEqual(valid);
  });
});
