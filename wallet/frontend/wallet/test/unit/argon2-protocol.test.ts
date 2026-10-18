// [F-KEY-03]: Argon2id de @noble/hashes con el vector de RFC 9106 §5.3 y, con los parámetros reales de los sobres
// (64 MiB, t=3, p=4), igual a la implementación nativa e independiente de Node (OpenSSL); límites de parámetros.
import { argon2Sync, randomBytes } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { describe, expect, it } from 'vitest';
import { ARGON2_BASELINE, deriveArgon2id, validateArgon2 } from '../../src/workers/argon2-protocol.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('Argon2id', () => {
  it('vector de RFC 9106 §5.3 (secreto y datos asociados)', () => {
    const tag = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    });
    expect(hex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('parámetros de los sobres: igual a la implementación nativa de Node', async () => {
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
    expect(hex(ours)).toBe(native.toString('hex'));
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
