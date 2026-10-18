// §10 regla 2: el release manifest de la app reproduce exactamente el vector cruzado de [W-04]
// (contracts/test/vectors/wire/release-manifest.json, copia en test/vectors/): los mismos bytes JCS, el mismo SHA-256 y
// la firma Ed25519 del vector verifica sobre esos bytes. Es el formato que consume el integrity monitor (P20).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../../build/config.ts';
import { serializeManifest, type ReleaseManifest } from '../../build/manifest.ts';

const vector = JSON.parse(readFileSync(resolve(APP_ROOT, 'test/vectors/wire/release-manifest.json'), 'utf8')) as {
  publicJwk: JsonWebKey;
  manifest: ReleaseManifest;
  manifestJson: string;
  manifestSha256: string;
  signatureBase64: string;
};

describe('vector de release manifest [W-04]', () => {
  it('la serialización JCS de la app produce los bytes del vector', () => {
    expect(serializeManifest(vector.manifest)).toBe(vector.manifestJson);
    expect(createHash('sha256').update(vector.manifestJson).digest('hex')).toBe(vector.manifestSha256);
  });

  it('la firma Ed25519 del vector verifica sobre esos bytes (y no sobre otros)', () => {
    const publicKey = createPublicKey({ key: vector.publicJwk, format: 'jwk' });
    const signature = Buffer.from(vector.signatureBase64, 'base64');
    expect(verify(null, Buffer.from(vector.manifestJson), publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from(vector.manifestJson.replace('wallet', 'wallex')), publicKey, signature)).toBe(
      false,
    );
  });
});
