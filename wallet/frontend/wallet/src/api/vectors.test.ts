// P17.T01 [F-SES-03]: la firma de requests críticos, el envelope de envío, el thumbprint RFC 7638 y el binding con
// OPAQUE reproducen los vectores cruzados (test/vectors/wire/{p256,session-binding}.json) que también verifican el
// backend y el signer; las firmas propias (WebCrypto, no determinísticas) verifican con la clave pública exportada.
import { describe, expect, it } from 'vitest';
import p256Vectors from '../../test/vectors/wire/p256.json';
import bindingVector from '../../test/vectors/wire/session-binding.json';
import { toHex, utf8 } from '../crypto/bytes.ts';
import { canonicalize, type Json } from './jcs.ts';
import { bodySha256Hex, canonicalRequest, criticalHeaders } from './request-signature.ts';
import {
  generateSessionKey,
  jwkThumbprint,
  sessionKeyBinding,
  sha256,
  signP256,
  verifyP256,
  type P256PublicJwk,
} from './session-key.ts';
import { signSubmission, submissionCanonical, type SubmissionEnvelope } from './submission.ts';

interface SignedVector {
  canonical: string;
  sha256: `0x${string}`;
  publicJwk: P256PublicJwk;
  jwkThumbprint: string;
  signature: string;
}

const vectors = p256Vectors as unknown as {
  criticalRequest: SignedVector & { body: string };
  submissionEnvelope: SignedVector & { object: SubmissionEnvelope };
  enrollment: SignedVector & { object: Record<string, Json> };
};

describe('request crítico [B-PSES-05]', () => {
  const v = vectors.criticalRequest;
  const [version, method = '', path = '', bodyHash = '', timestamp = '', nonce = '', sessionId = ''] =
    v.canonical.split('\n');

  it('el canónico del vector se arma igual y su firma verifica con la JWK del vector', async () => {
    expect(version).toBe('MTW-REQ-V1');
    expect(await bodySha256Hex(v.body)).toBe(bodyHash);
    expect(
      canonicalRequest({
        method: method.toLowerCase(),
        path,
        bodySha256Hex: bodyHash,
        timestamp: Number(timestamp),
        nonce,
        platformSessionId: sessionId,
      }),
    ).toBe(v.canonical);
    expect(toHex(await sha256(utf8(v.canonical)))).toBe(v.sha256);
    expect(await jwkThumbprint(v.publicJwk)).toBe(v.jwkThumbprint);
    expect(await verifyP256(v.publicJwk, v.canonical, v.signature)).toBe(true);
    expect(await verifyP256(v.publicJwk, `${v.canonical}x`, v.signature)).toBe(false);
  });

  it('los headers propios: timestamp en segundos, nonce de 16 bytes y firma P1363 que verifica', async () => {
    const key = await generateSessionKey();
    const headers = await criticalHeaders({ token: 'jws.de.prueba', sessionId, key }, 'POST', path, v.body, {
      now: () => Number(timestamp) * 1000 + 999,
      randomHex: () => nonce,
    });
    const { 'X-Session-Signature': signature = '', ...rest } = headers;
    expect(rest).toEqual({
      'X-Platform-Session': 'jws.de.prueba',
      'X-Session-Timestamp': timestamp,
      'X-Session-Nonce': nonce,
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const own = canonicalRequest({
      method: 'POST',
      path,
      bodySha256Hex: bodyHash,
      timestamp: Number(timestamp),
      nonce,
      platformSessionId: sessionId,
    });
    expect(await verifyP256(key.publicJwk, own, signature)).toBe(true);
  });
});

describe('session key y binding [B-PSES-02]', () => {
  it('thumbprint y HMAC de binding del vector', async () => {
    const v = bindingVector as {
      opaqueSessionKey: string;
      sessionPublicJwk: P256PublicJwk;
      jwkThumbprint: string;
      loginAttemptId: string;
      binding: string;
    };
    expect(await jwkThumbprint(v.sessionPublicJwk)).toBe(v.jwkThumbprint);
    expect(await sessionKeyBinding(v.opaqueSessionKey, v.jwkThumbprint, v.loginAttemptId)).toBe(v.binding);
  });

  it('la privada no es exportable y la JWK pública tiene exactamente kty, crv, x, y', async () => {
    const key = await generateSessionKey();
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', key.privateKey)).rejects.toThrow();
    expect(Object.keys(key.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(key.thumbprint).toBe(await jwkThumbprint(key.publicJwk));
    const signature = await signP256(key.privateKey, 'mensaje');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyP256(key.publicJwk, 'mensaje', signature)).toBe(true);
  });
});

describe('envelope de envío [B-PSES-06] y JCS', () => {
  it('el canónico del vector y su firma', async () => {
    const v = vectors.submissionEnvelope;
    expect(submissionCanonical(v.object)).toBe(v.canonical);
    expect(toHex(await sha256(utf8(v.canonical)))).toBe(v.sha256);
    expect(await verifyP256(v.publicJwk, v.canonical, v.signature)).toBe(true);
  });

  it('el envelope propio fija submittedAt sin milisegundos y su firma verifica', async () => {
    const key = await generateSessionKey();
    const { object } = vectors.submissionEnvelope;
    const signed = await signSubmission(
      key,
      { operationId: object.operationId, safeTxHash: object.safeTxHash, sessionId: object.sessionId },
      new Date('2026-10-18T12:34:56.789Z'),
    );
    expect(signed.submissionEnvelope.submittedAt).toBe('2026-10-18T12:34:56Z');
    expect(
      await verifyP256(
        key.publicJwk,
        submissionCanonical(signed.submissionEnvelope),
        signed.submissionEnvelopeSignature,
      ),
    ).toBe(true);
  });

  it('JCS ordena claves por unidades UTF-16 y rechaza lo que no es JSON entero', () => {
    const v = vectors.enrollment;
    expect(canonicalize(v.object)).toBe(v.canonical);
    expect(canonicalize({ b: [1, true, null, 'x'], a: { d: 'é', c: '"' } })).toBe(
      '{"a":{"c":"\\"","d":"é"},"b":[1,true,null,"x"]}',
    );
    expect(() => canonicalize(1.5)).toThrow(TypeError);
    expect(() => canonicalize({ a: undefined } as unknown as Json)).toThrow(TypeError);
  });
});
