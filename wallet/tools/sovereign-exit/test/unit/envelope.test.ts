// Sobres U.enc y R.enc contra los vectores de contracts/ (Argon2id real de @noble/hashes, HKDF y AES-GCM de WebCrypto):
// la herramienta abre los dos con su Password y obtiene la clave de la dirección; una Password equivocada, un sobre
// movido de wallet (AAD) o parámetros fuera de los de MT Wallet no abren nada.
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  envelopeAad,
  EnvelopeError,
  normalizePassword,
  openEnvelope,
  parseEnvelope,
} from '../../src/crypto/envelope.ts';
import { vector, type EnvelopeVector } from './vectors.ts';

const { envelopes } = vector('wire/envelope.json') as { envelopes: EnvelopeVector[] };

describe('sobres de los vectores', () => {
  it.each(envelopes.map((v) => [v.envelope.role, v] as const))(
    '%s: AAD y clave de la label con su Password',
    async (_, v) => {
      const envelope = parseEnvelope(v.envelope);
      expect(envelopeAad(envelope)).toBe(v.aad);
      const key = await openEnvelope(envelope, `  ${v.password.toUpperCase()} `);
      expect(key).toEqual(toBytes(keccak256(toBytes(v.keyLabel))));
    },
  );

  it('Password equivocada o sobre movido de wallet: no abre', async () => {
    const v = envelopes.find((e) => e.envelope.role === 'R');
    if (!v) throw new Error('falta el vector de R');
    await expect(openEnvelope(parseEnvelope(v.envelope), 'otra password')).rejects.toThrow('no abre este sobre');
    const moved = parseEnvelope({ ...v.envelope, walletId: '00000000-0000-4000-8000-000000000000' });
    await expect(openEnvelope(moved, v.password)).rejects.toThrow(EnvelopeError);
  });
});

describe('forma del sobre', () => {
  const base: Record<string, unknown> = envelopes[0]?.envelope ?? {};
  it.each([
    ['otro formato', { format: 'otro' }],
    ['otra cadena', { chainId: 1 }],
    ['otro rol', { role: 'S' }],
    ['dirección inválida', { keyAddress: '0x12' }],
    ['versión inválida', { keyVersion: 0 }],
    ['memoria enorme', { kdf: { ...(base.kdf as object), memoryKiB: 4_194_304 } }],
    ['otro cifrado', { cipher: { alg: 'AES-128-CBC', nonce: 'x' } }],
    ['texto cifrado corto', { ciphertext: 'AAAA' }],
  ])('%s: no se usa', (_, patch) => {
    expect(() => parseEnvelope({ ...base, ...patch })).toThrow(EnvelopeError);
  });

  it('la Password se normaliza como en las apps', () => {
    expect(normalizePassword('  Uno   DOS tres\tcuatro\ncinco ')).toBe('uno dos tres cuatro cinco');
  });
});
