// P18.T01 / P18.T09.b ([F-SEC-08]): la atestación de S del vector de contracts/ (wire/jws.json, SignerKeyAttestation)
// verifica con su clave en el formato embebido en el build (SPKI DER en base64) y se rechaza con otra clave, otra
// wallet, otra dirección, otra red, un payload alterado o un algoritmo distinto.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import jwsVectors from '../../test/vectors/wire/jws.json';
import { fromBase64Url, toBase64Url, utf8 } from '../crypto/bytes.ts';
import { AttestationError, verifySignerKeyAttestation } from './attestation.ts';

interface Token {
  name: string;
  publicJwk: { x: string };
  claims: { walletId: string; executor: Address; shardId: string; chainId: number; issuedAt: number };
  jws: string;
}

const tokens = (jwsVectors as unknown as { tokens: Token[] }).tokens;
const attestation = tokens.find((t) => t.name === 'SignerKeyAttestation');
const other = tokens.find((t) => t.name === 'PlatformSession');
if (!attestation || !other) throw new Error('vector sin SignerKeyAttestation');

/** SPKI DER de una clave Ed25519 (prefijo fijo de RFC 8410 + 32 bytes) en base64, como en system-contracts. */
const spki = (x: string) => {
  const der = Uint8Array.from([
    ...[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00],
    ...fromBase64Url(x),
  ]);
  return btoa(String.fromCharCode(...der));
};
const KEY = spki(attestation.publicJwk.x);
const expected = { walletId: attestation.claims.walletId, executor: attestation.claims.executor };

describe('SignerKeyAttestation de S', () => {
  it('la del vector verifica con la clave fijada y devuelve sus claims', async () => {
    expect(KEY).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
    await expect(verifySignerKeyAttestation(attestation.jws, KEY, expected)).resolves.toEqual(attestation.claims);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['firmada con otra clave', () => verifySignerKeyAttestation(attestation.jws, spki(other.publicJwk.x), expected)],
    ['de otra wallet', () => verifySignerKeyAttestation(attestation.jws, KEY, { ...expected, walletId: 'otra' })],
    [
      'de otra dirección',
      () =>
        verifySignerKeyAttestation(attestation.jws, KEY, {
          ...expected,
          executor: '0x000000000000000000000000000000000000dEaD',
        }),
    ],
    ['de otra red', () => verifySignerKeyAttestation(attestation.jws, KEY, { ...expected, chainId: 1 })],
    [
      'con el payload alterado',
      () => {
        const [h, , s] = attestation.jws.split('.');
        const payload = toBase64Url(utf8(JSON.stringify({ ...attestation.claims, shardId: 'otro' })));
        return verifySignerKeyAttestation(`${h ?? ''}.${payload}.${s ?? ''}`, KEY, expected);
      },
    ],
    [
      'con alg none',
      () => {
        const [, p, s] = attestation.jws.split('.');
        const header = toBase64Url(utf8('{"alg":"none","typ":"JWT"}'));
        return verifySignerKeyAttestation(`${header}.${p ?? ''}.${s ?? ''}`, KEY, expected);
      },
    ],
    ['mal formada', () => verifySignerKeyAttestation('no.es-un.jws!', KEY, expected)],
  ])('se rechaza %s', async (_label, verify) => {
    await expect(verify()).rejects.toBeInstanceOf(AttestationError);
  });
});
