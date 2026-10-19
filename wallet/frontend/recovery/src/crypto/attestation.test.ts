// [B-SIG-07]/[F-SEC-08]: la SignerKeyAttestation del vector de contracts/ verifica con su clave (como SPKI fijado) y
// sólo para su wallet y su S; con otra clave, otro contenido o un JWS roto, no.
import { describe, expect, it } from 'vitest';
import jwsVectors from '../../test/vectors/wire/jws.json' with { type: 'json' };
import { AttestationError, importAttestationKey, verifySignerKeyAttestation } from './attestation.ts';
import { base64UrlToBytes } from './encoding.ts';

const vector = jwsVectors.tokens.find((t) => t.name === 'SignerKeyAttestation');
const session = jwsVectors.tokens.find((t) => t.name === 'PlatformSession');

/** SPKI DER de una clave Ed25519 (prefijo fijo + 32 bytes) en base64, como la embebe el build. */
function spki(x: string): string {
  const der = new Uint8Array([
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
    ...base64UrlToBytes(x, 32),
  ]);
  return btoa(String.fromCharCode(...der));
}

describe('SignerKeyAttestation', () => {
  if (!vector || !session) throw new Error('faltan vectores JWS');
  const claims = vector.claims as { walletId: string; executor: `0x${string}`; shardId: string };

  it('verifica con la clave fijada y devuelve la S atestada', async () => {
    const key = await importAttestationKey(spki(vector.publicJwk.x));
    await expect(
      verifySignerKeyAttestation(vector.jws, key, { walletId: claims.walletId, executor: claims.executor }),
    ).resolves.toMatchObject({ shardId: claims.shardId, executor: claims.executor, chainId: 8453 });
  });

  it('otra clave, otra wallet, otra S o un JWS adulterado: no', async () => {
    const key = await importAttestationKey(spki(vector.publicJwk.x));
    const other = await importAttestationKey(spki(session.publicJwk.x));
    const expected = { walletId: claims.walletId, executor: claims.executor };
    await expect(verifySignerKeyAttestation(vector.jws, other, expected)).rejects.toThrow('no está firmada');
    await expect(verifySignerKeyAttestation(vector.jws, key, { ...expected, walletId: 'otra' })).rejects.toThrow(
      'otra wallet',
    );
    await expect(
      verifySignerKeyAttestation(vector.jws, key, {
        ...expected,
        executor: '0x0000000000000000000000000000000000000001',
      }),
    ).rejects.toThrow('otra clave S');
    const [header, payload, signature] = vector.jws.split('.');
    const forged = `${header ?? ''}.${(payload ?? '').slice(0, -2)}AA.${signature ?? ''}`;
    await expect(verifySignerKeyAttestation(forged, key, expected)).rejects.toBeInstanceOf(AttestationError);
    await expect(verifySignerKeyAttestation('no-es-un-jws', key, expected)).rejects.toThrow('JWS compacto');
    await expect(importAttestationKey(btoa('corta'))).rejects.toThrow('no es Ed25519');
  });
});
