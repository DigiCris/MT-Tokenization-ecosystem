// P11.T11 [B-SIG-07]/[W-03]: SignerKeyAttestation emitida por el signer: JWS compacto EdDSA con header JCS
// {alg, kid, typ} (kid = thumbprint RFC 7638 de la clave), payload JCS {walletId, shardId, executor, chainId,
// issuedAt}; mismo formato que el vector compartido; verificable con una librería independiente (jose) y la JWK que
// exporta `pnpm attestation:public-key` para los frontends; cualquier alteración la invalida.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { compactVerify, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { KeyAttestor } from '../src/attestation.ts';
import { Secret } from '../src/config/secret.ts';
import { ed25519Kid } from '../src/crypto/jws.ts';
import { testEdKey } from './helpers/keys.ts';
import { SIGNER_ROOT } from './helpers/paths.ts';
import { vector } from './helpers/vectors.ts';

const key = testEdKey();
const attestor = new KeyAttestor({
  privateKey: new Secret(key.privateKey),
  publicKey: key.publicKey,
  shardId: 'dev-1',
  chainId: 8453,
});
const decode = (part: string) => Buffer.from(part, 'base64url').toString('utf8');

describe('SignerKeyAttestation', () => {
  const walletId = crypto.randomUUID();
  const executor = '0xc80D387fCc59cB57AEf0eC2b137C77D26474288E' as const;
  const jws = attestor.issue({ walletId, executor, issuedAt: 1792189347 });

  it('header y payload en JSON canónico, con el kid de la clave', () => {
    const [header, payload] = jws.split('.');
    expect(decode(header!)).toBe(`{"alg":"EdDSA","kid":"${ed25519Kid(key.publicKey)}","typ":"JWT"}`);
    expect(decode(payload!)).toBe(
      `{"chainId":8453,"executor":"${executor}","issuedAt":1792189347,"shardId":"dev-1","walletId":"${walletId}"}`,
    );
  });

  it('mismo formato que el vector compartido (wire/jws.json)', () => {
    const v = vector<{ tokens: { name: string; jws: string }[] }>('wire/jws.json').tokens.find(
      (t) => t.name === 'SignerKeyAttestation',
    )!;
    const [vh, vp] = v.jws.split('.');
    const [h, p] = jws.split('.');
    expect(Object.keys(JSON.parse(decode(h!)) as object)).toEqual(Object.keys(JSON.parse(decode(vh!)) as object));
    expect(Object.keys(JSON.parse(decode(p!)) as object)).toEqual(Object.keys(JSON.parse(decode(vp!)) as object));
  });

  it('verifica con jose y la JWK exportada para los frontends; alterada, no', async () => {
    const exported = spawnSync('node', [resolve(SIGNER_ROOT, 'scripts/attestation-public-key.ts')], {
      encoding: 'utf8',
      env: { ...process.env, APP_ENV: 'local', SIGNER_ATTESTATION_PUBLIC_KEY: key.publicBase64 },
    });
    const { jwk, kid } = JSON.parse(exported.stdout) as { jwk: { kty: string; crv: string; x: string }; kid: string };
    expect(kid).toBe(ed25519Kid(key.publicKey));
    const publicKey = await importJWK(jwk, 'EdDSA');
    const { payload, protectedHeader } = await compactVerify(jws, publicKey);
    expect(protectedHeader).toMatchObject({ alg: 'EdDSA', kid });
    expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toMatchObject({ walletId, executor, chainId: 8453 });
    const [h, , s] = jws.split('.');
    const forged = Buffer.from(
      decode(jws.split('.')[1]!).replace(executor, '0x0000000000000000000000000000000000000abc'),
    ).toString('base64url');
    await expect(compactVerify(`${h}.${forged}.${s}`, publicKey)).rejects.toThrow();
    const other = await importJWK(
      testEdKey().publicKey.export({ format: 'jwk' }) as Parameters<typeof importJWK>[0],
      'EdDSA',
    );
    await expect(compactVerify(jws, other)).rejects.toThrow();
  });
});
