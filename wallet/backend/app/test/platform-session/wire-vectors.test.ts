// Formatos de PlatformSession contra los vectores cruzados de contracts/test/vectors/wire (copia byte a byte en
// test/vectors, SHA256SUMS): token JWS EdDSA [W-03], request crítico y envelope de envío [W-02]/[B-PSES-05/06], binding
// de la session key [B-PSES-02] y matriz de scopes [W-07]. Signer y frontends implementan los mismos vectores.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/secret.ts';
import { deriveAuthSecret, opaqueInput, type KdfParams } from '../../src/platform-session/auth-secret.ts';
import { jwkThumbprint, verifyP256, type P256PublicJwk } from '../../src/platform-session/keys.ts';
import { sessionKeyBinding } from '../../src/platform-session/opaque.ts';
import {
  canonicalRequest,
  submissionCanonical,
  submissionProblem,
  type SubmissionEnvelope,
} from '../../src/platform-session/request-signature.ts';
import { STEP_UP_LISTENER } from '../../src/platform-session/step-up.ts';
import {
  PLATFORM_SCOPES,
  PlatformSessionIssuer,
  type ChallengeCompletionClaims,
  type PlatformSessionClaims,
} from '../../src/platform-session/token.ts';

const wire = (name: string) =>
  JSON.parse(readFileSync(new URL(`../vectors/wire/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

interface P256Vector {
  canonical: string;
  publicJwk: P256PublicJwk;
  jwkThumbprint: string;
  signature: string;
}

/** Clave Ed25519 de test del emisor (mismo seed que contracts/script/wire-vectors.mjs). */
function vectorIssuerKeys() {
  const seed = sha256('mtw-vector-session-issuer');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

describe('token de PlatformSession [W-03]', () => {
  const vectors = wire('jws.json') as {
    tokens: { name: string; kid: string; claims: PlatformSessionClaims; jws: string }[];
  };
  const vector = vectors.tokens.find((t) => t.name === 'PlatformSession');
  if (!vector) throw new Error('sin vector PlatformSession');

  it('firmar los claims del vector produce exactamente el mismo JWS (header y payload JCS, Ed25519 determinístico)', async () => {
    const { privateKey, publicKey } = vectorIssuerKeys();
    const issuer = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: vector.kid });
    expect(await issuer.sign(vector.claims)).toBe(vector.jws);
  });

  it('verifica el JWS del vector dentro de su vigencia y lo rechaza fuera o con otra audiencia', async () => {
    const { privateKey, publicKey } = vectorIssuerKeys();
    const issuer = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: vector.kid });
    const during = (vector.claims.issuedAt + 60) * 1000;
    expect(await issuer.verify(vector.jws, during)).toEqual(vector.claims);
    await expect(issuer.verify(vector.jws, vector.claims.expiresAt * 1000)).rejects.toMatchObject({
      problem: 'EXPIRED',
    });
    const signerSide = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, {
      kid: vector.kid,
      audience: 'mtw-signer',
    });
    expect((await signerSide.verify(vector.jws, during)).scope).toBe('OPERATIONS');
    const other = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, {
      kid: vector.kid,
      audience: 'mtw-otro',
    });
    await expect(other.verify(vector.jws, during)).rejects.toMatchObject({ problem: 'AUDIENCE' });
  });

  it('el kid por defecto es el thumbprint RFC 7638 de la clave del emisor', async () => {
    const { privateKey, publicKey } = vectorIssuerKeys();
    const issuer = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey);
    const jwk = publicKey.export({ format: 'jwk' });
    const expected = createHash('sha256')
      .update(`{"crv":"Ed25519","kty":"OKP","x":"${String(jwk.x)}"}`)
      .digest('base64url');
    expect(issuer.kid).toBe(expected);
    // Un JWS con otro kid no se intenta verificar.
    await expect(issuer.verify(vector.jws, (vector.claims.issuedAt + 60) * 1000)).rejects.toMatchObject({
      problem: 'UNKNOWN_KEY',
    });
  });
});

describe('atestación ChallengeCompletion [W-03] (P14)', () => {
  const vectors = wire('jws.json') as {
    tokens: { name: string; kid: string; claims: ChallengeCompletionClaims; jws: string }[];
  };
  const vector = vectors.tokens.find((t) => t.name === 'ChallengeCompletion');
  if (!vector) throw new Error('sin vector ChallengeCompletion');

  it('firmar los claims del vector produce exactamente el mismo JWS y se verifica con la clave del emisor', async () => {
    const { privateKey, publicKey } = vectorIssuerKeys();
    const issuer = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: vector.kid });
    expect(await issuer.signChallengeCompletion(vector.claims)).toBe(vector.jws);
    expect(await issuer.verifyChallengeCompletion(vector.jws)).toEqual(vector.claims);
  });

  it('rechaza un JWS adulterado, de otra clave o con claims fuera del formato', async () => {
    const { privateKey, publicKey } = vectorIssuerKeys();
    const issuer = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: vector.kid });
    const [header = '', payload = '', signature = ''] = vector.jws.split('.');
    const altered = Buffer.from(JSON.stringify({ ...vector.claims, amount: '1500000001' }), 'utf8').toString(
      'base64url',
    );
    await expect(issuer.verifyChallengeCompletion(`${header}.${altered}.${signature}`)).rejects.toMatchObject({
      problem: 'SIGNATURE',
    });
    const other = await PlatformSessionIssuer.create(new Secret(privateKey), publicKey, { kid: 'otra-clave' });
    await expect(other.verifyChallengeCompletion(vector.jws)).rejects.toMatchObject({ problem: 'UNKNOWN_KEY' });
    // Un PlatformSession firmado por el mismo emisor no es una ChallengeCompletion.
    const session = vectors.tokens.find((t) => t.name === 'PlatformSession');
    await expect(issuer.verifyChallengeCompletion(session?.jws ?? '')).rejects.toMatchObject({ problem: 'MALFORMED' });
    // Y el emisor no firma claims sin checksum o con campos de más.
    await expect(
      issuer.signChallengeCompletion({ ...vector.claims, safe: `0x${vector.claims.safe.slice(2).toUpperCase()}` }),
    ).rejects.toThrow();
    await expect(
      issuer.signChallengeCompletion({ ...vector.claims, extra: true } as unknown as ChallengeCompletionClaims),
    ).rejects.toThrow();
    expect(payload.length).toBeGreaterThan(0);
  });
});

describe('request crítico y envelope de envío [W-02]', () => {
  const p256 = wire('p256.json') as {
    criticalRequest: P256Vector & { body: string };
    submissionEnvelope: P256Vector & { object: SubmissionEnvelope };
  };

  it('string canónico MTW-REQ-V1, thumbprint y firma P-256 del vector', () => {
    const v = p256.criticalRequest;
    const [, method = '', path = '', , timestamp = '', nonce = '', sessionId = ''] = v.canonical.split('\n');
    expect(canonicalRequest({ method, path, body: v.body, timestamp, nonce, sessionId })).toBe(v.canonical);
    expect(jwkThumbprint(v.publicJwk)).toBe(v.jwkThumbprint);
    expect(verifyP256(v.publicJwk, v.canonical, v.signature)).toBe(true);
    expect(verifyP256(v.publicJwk, `${v.canonical}x`, v.signature)).toBe(false);
  });

  it('envelope MTW-SUBMIT-V1: canónico JCS, firma y validez dentro de la sesión', () => {
    const v = p256.submissionEnvelope;
    expect(submissionCanonical(v.object)).toBe(v.canonical);
    const claims = {
      sessionId: v.object.sessionId,
      issuedAt: v.object.submittedAt - 100,
      expiresAt: v.object.submittedAt + 800,
      sessionPublicKey: v.publicJwk,
    };
    expect(submissionProblem({ envelope: v.object, signature: v.signature, claims })).toBeNull();
    expect(
      submissionProblem({
        envelope: v.object,
        signature: v.signature,
        claims,
        executionTime: (v.object.submittedAt + 3600) * 1000,
      }),
    ).toBeNull();
    expect(
      submissionProblem({
        envelope: v.object,
        signature: v.signature,
        claims,
        executionTime: (v.object.submittedAt + 24 * 3600 + 1) * 1000,
      }),
    ).toBe('STALE');
    expect(
      submissionProblem({
        envelope: v.object,
        signature: v.signature,
        claims: { ...claims, expiresAt: v.object.submittedAt - 1 },
      }),
    ).toBe('OUTSIDE_SESSION');
    expect(
      submissionProblem({
        envelope: v.object,
        signature: v.signature,
        claims: { ...claims, issuedAt: v.object.submittedAt + 1 },
      }),
    ).toBe('OUTSIDE_SESSION');
    expect(
      submissionProblem({ envelope: { ...v.object, sessionId: crypto.randomUUID() }, signature: v.signature, claims }),
    ).toBe('SESSION_MISMATCH');
    expect(
      submissionProblem({
        envelope: { ...v.object, submittedAt: v.object.submittedAt + 1 },
        signature: v.signature,
        claims,
      }),
    ).toBe('SIGNATURE');
  });
});

describe('binding OPAQUE de la session key [B-PSES-02]', () => {
  it('HMAC(clave de sesión OPAQUE, thumbprint ‖ loginAttemptId) del vector', () => {
    const v = wire('session-binding.json') as {
      opaqueSessionKey: string;
      sessionPublicJwk: P256PublicJwk;
      jwkThumbprint: string;
      loginAttemptId: string;
      binding: string;
    };
    expect(jwkThumbprint(v.sessionPublicJwk)).toBe(v.jwkThumbprint);
    expect(sessionKeyBinding(v.opaqueSessionKey, v.sessionPublicJwk, v.loginAttemptId)).toBe(v.binding);
  });
});

describe('AuthSecret_U [F-KEY-03]', () => {
  it('Argon2id + HKDF U-auth-v1 del vector de sobres (lo que dev:session y el frontend usan como entrada OPAQUE)', () => {
    const v = wire('envelope.json') as {
      envelopes: { envelope: { role: string; kdf: KdfParams }; password: string; authSecretHex?: string }[];
    };
    const u = v.envelopes.find((e) => e.envelope.role === 'U');
    if (!u?.authSecretHex) throw new Error('sin vector de U');
    const secret = deriveAuthSecret(u.password, u.envelope.kdf);
    expect(`0x${opaqueInput(secret)}`).toBe(u.authSecretHex);
  });
});

describe('matriz de scopes [W-07]', () => {
  it('los scopes y la app de cada scope de step-up coinciden con el vector', () => {
    const v = wire('scopes.json') as { scopes: Record<string, { app: 'Wallet' | 'Recovery' }> };
    expect(Object.keys(v.scopes).sort()).toEqual([...PLATFORM_SCOPES].sort());
    for (const [scope, client] of Object.entries(STEP_UP_LISTENER)) {
      expect(v.scopes[scope]?.app, scope).toBe(client === 'WALLET' ? 'Wallet' : 'Recovery');
    }
  });
});
