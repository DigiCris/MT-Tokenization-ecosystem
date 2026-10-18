// [F-KEY-03], ADR-013: Argon2id de hash-wasm (el del worker) con los vectores de la implementación de referencia
// (phc-winner-argon2, Argon2id v1.3) y, con los parámetros reales de los sobres (64 MiB, t=3, p=4), igual a la
// implementación nativa e independiente de Node (OpenSSL, validada con el vector de RFC 9106 §5.3) y a @noble/hashes
// (la implementación anterior: los sobres ya creados abren igual); límites de parámetros.
import { argon2Sync, randomBytes } from 'node:crypto';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { argon2id } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { ARGON2_BASELINE, deriveArgon2id, validateArgon2 } from '../../src/workers/argon2-protocol.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('Argon2id', () => {
  // hash-wasm no admite datos asociados (el parámetro X de RFC 9106), que la app no usa: el vector de RFC 9106 §5.3
  // valida el oráculo independiente contra el que se compara después la derivación de la app.
  it('vector de RFC 9106 §5.3 (secreto y datos asociados) con la implementación de Node', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it.each([
    [2, 65_536, 1, 'password', 'somesalt', '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7'],
    [2, 256, 1, 'password', 'somesalt', '9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe'],
    [2, 256, 2, 'password', 'somesalt', '6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037'],
    [1, 65_536, 1, 'password', 'somesalt', 'f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98'],
    [4, 65_536, 1, 'password', 'somesalt', '9025d48e68ef7395cca9079da4c4ec3affb3c8911fe4f86d1a2520856f63172c'],
    [2, 65_536, 1, 'differentpassword', 'somesalt', '0b84d652cf6b0c4beaef0dfe278ba6a80df6696281d7e0d2891b817d8c458fde'],
    [2, 65_536, 1, 'password', 'diffsalt', 'bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c'],
  ] as const)(
    'hash-wasm: vector de referencia t=%i, m=%i KiB, p=%i (%s, %s)',
    async (iterations, memorySize, parallelism, password, salt, expected) => {
      const tag = await argon2id({
        password,
        salt,
        iterations,
        memorySize,
        parallelism,
        hashLength: 32,
        outputType: 'hex',
      });
      expect(tag).toBe(expected);
    },
  );

  it('parámetros de los sobres: igual a la implementación nativa de Node y a @noble/hashes', async () => {
    const password = randomBytes(24);
    const salt = randomBytes(16);
    const ours = await deriveArgon2id({
      ...ARGON2_BASELINE,
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
    });
    const native = argon2Sync('argon2id', {
      message: password,
      nonce: salt,
      parallelism: ARGON2_BASELINE.parallelism,
      tagLength: ARGON2_BASELINE.outputLength,
      memory: ARGON2_BASELINE.memoryKiB,
      passes: ARGON2_BASELINE.iterations,
    });
    const noble = nobleArgon2id(new Uint8Array(password), new Uint8Array(salt), {
      m: ARGON2_BASELINE.memoryKiB,
      t: ARGON2_BASELINE.iterations,
      p: ARGON2_BASELINE.parallelism,
      dkLen: ARGON2_BASELINE.outputLength,
    });
    expect(hex(ours)).toBe(native.toString('hex'));
    expect(hex(ours)).toBe(hex(noble));
  });

  it.each([
    ['memoria excesiva (sobre adulterado)', { memoryKiB: 4 * 1024 * 1024 }],
    ['memoria menor a 8·p', { memoryKiB: 16 }],
    ['iteraciones fuera de rango', { iterations: 0 }],
    ['paralelismo fuera de rango', { parallelism: 64 }],
    ['salida distinta de 32 bytes', { outputLength: 64 }],
  ])('rechaza %s', (_label, overrides) => {
    expect(() => {
      validateArgon2({ ...ARGON2_BASELINE, ...overrides }, new Uint8Array(16));
    }).toThrow(RangeError);
  });

  it('rechaza un salt corto', () => {
    expect(() => {
      validateArgon2(ARGON2_BASELINE, new Uint8Array(8));
    }).toThrow(RangeError);
  });
});
