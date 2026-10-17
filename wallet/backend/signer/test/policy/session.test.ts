// [B-PSES-04/06], [W-02]/[W-03] en el signer: PlatformSession (JWS EdDSA del emisor, audiencia mtw-signer), envelope de
// envío firmado con la session key P-256 y validez al momento del envío, ChallengeCompletion e IntegrityAttestation,
// contra los vectores compartidos (wire/jws.json, wire/p256.json) y con cada caso de rechazo.
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519Kid, pinnedKeys, signJws, type PinnedKeys } from '../../src/crypto/jws.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { p256Thumbprint, type P256Jwk } from '../../src/crypto/p256.ts';
import {
  verifyChallengeCompletion,
  verifyIntegrity,
  verifySignerKeyAttestation,
  type ChallengeExpectation,
} from '../../src/policy/attestations.ts';
import {
  SessionError,
  submissionCanonical,
  verifyPlatformSessionToken,
  verifySubmission,
  type PlatformSessionClaims,
  type SubmissionEnvelope,
} from '../../src/policy/session.ts';
import { vector } from '../helpers/vectors.ts';

interface JwsVector {
  name: string;
  kid: string;
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  claims: Record<string, unknown>;
  jws: string;
}
const jws = vector<{ tokens: JwsVector[] }>('wire/jws.json').tokens;
const p256 = vector<{
  submissionEnvelope: {
    object: SubmissionEnvelope;
    canonical: string;
    publicJwk: P256Jwk;
    jwkThumbprint: string;
    signature: string;
  };
}>('wire/p256.json');
const tokenOf = (name: string) => jws.find((t) => t.name === name)!;
const keysOf = (t: JwsVector): PinnedKeys => new Map([[t.kid, createPublicKey({ key: t.publicJwk, format: 'jwk' })]]);

const sessionVector = tokenOf('PlatformSession');
const claimsVector = sessionVector.claims as unknown as PlatformSessionClaims;

describe('PlatformSession', () => {
  it('verifica el token del vector y sus claims', async () => {
    const claims = await verifyPlatformSessionToken(sessionVector.jws, keysOf(sessionVector), 'mtw');
    expect(claims).toMatchObject({ scope: 'OPERATIONS', authMethod: 'OPAQUE_U', walletId: claimsVector.walletId });
    expect(p256Thumbprint(claims.sessionPublicKey)).toBe(p256.submissionEnvelope.jwkThumbprint);
  });

  it('rechaza kid desconocido, firma alterada, otra plataforma y otra audiencia', async () => {
    const problem = async (token: string, keys: PinnedKeys, platform = 'mtw') => {
      try {
        await verifyPlatformSessionToken(token, keys, platform);
        return 'OK';
      } catch (error) {
        return error instanceof SessionError ? error.problem : 'OTRO';
      }
    };
    const other = generateKeyPairSync('ed25519');
    expect(await problem(sessionVector.jws, pinnedKeys(other.publicKey))).toBe('TOKEN_INVALID');
    const [h, p, s] = sessionVector.jws.split('.');
    const tampered = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('A') ? 'B' : 'A'}`;
    expect(await problem(tampered, keysOf(sessionVector))).toBe('TOKEN_INVALID');
    expect(await problem(sessionVector.jws, keysOf(sessionVector), 'otra')).toBe('PLATFORM');
    const kid = ed25519Kid(other.publicKey);
    const apiOnly = signJws({ ...sessionVector.claims, aud: ['mtw-api'] }, other.privateKey, kid);
    expect(await problem(apiOnly, pinnedKeys(other.publicKey))).toBe('AUDIENCE');
    const tooLong = signJws({ ...sessionVector.claims, expiresAt: claimsVector.issuedAt + 901 }, other.privateKey, kid);
    expect(await problem(tooLong, pinnedKeys(other.publicKey))).toBe('TOKEN_INVALID');
    const alg = Buffer.from(JSON.stringify({ alg: 'none', kid })).toString('base64url');
    expect(await problem(`${alg}.${p}.`, pinnedKeys(other.publicKey))).toBe('TOKEN_INVALID');
  });
});

describe('envelope de envío [B-PSES-06]', () => {
  const env = p256.submissionEnvelope;
  const base = {
    claims: claimsVector,
    envelope: env.object,
    envelopeSignature: env.signature,
    operationId: env.object.operationId,
    walletId: claimsVector.walletId!,
    safe: claimsVector.safe!,
    safeTxHash: env.object.safeTxHash,
    now: env.object.submittedAt + 30,
    maxAgeSeconds: 86_400,
    clockSkewSeconds: 60,
  };
  const problem = (overrides: Partial<typeof base>) => {
    try {
      verifySubmission({ ...base, ...overrides });
      return 'OK';
    } catch (error) {
      return error instanceof SessionError ? error.problem : 'OTRO';
    }
  };

  it('el canónico y la firma del vector verifican', () => {
    expect(submissionCanonical(env.object)).toBe(env.canonical);
    expect(problem({})).toBe('OK');
  });

  it('sigue valiendo después de vencida la sesión si el envío fue dentro (hasta 24 h)', () => {
    expect(problem({ now: claimsVector.expiresAt + 3_600 })).toBe('OK');
    expect(problem({ now: env.object.submittedAt + 86_400 })).toBe('OK');
    expect(problem({ now: env.object.submittedAt + 86_401 })).toBe('SIGNATURE_STALE');
  });

  it('rechaza envelope de otra operación, SafeTx, sesión, wallet o Safe', () => {
    expect(problem({ operationId: crypto.randomUUID() })).toBe('ENVELOPE_MISMATCH');
    expect(problem({ safeTxHash: `0x${'11'.repeat(32)}` })).toBe('ENVELOPE_MISMATCH');
    expect(problem({ claims: { ...claimsVector, sessionId: crypto.randomUUID() } })).toBe('ENVELOPE_MISMATCH');
    expect(problem({ walletId: crypto.randomUUID() })).toBe('WALLET_MISMATCH');
    expect(problem({ safe: '0x0000000000000000000000000000000000000abc' })).toBe('WALLET_MISMATCH');
    expect(problem({ claims: { ...claimsVector, safe: null } })).toBe('WALLET_MISMATCH');
  });

  it('rechaza firma inválida o de otra session key', () => {
    expect(problem({ envelopeSignature: `${env.signature.slice(0, -2)}AA` })).toBe('ENVELOPE_SIGNATURE');
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = other.publicKey.export({ format: 'jwk' }) as P256Jwk;
    expect(
      problem({ claims: { ...claimsVector, sessionPublicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } } }),
    ).toBe('ENVELOPE_SIGNATURE');
  });

  it('rechaza envíos fuera de la vigencia de la sesión o con fecha futura', () => {
    const resign = (envelope: SubmissionEnvelope, key: KeyObject) =>
      sign('sha256', Buffer.from(submissionCanonical(envelope)), { key, dsaEncoding: 'ieee-p1363' }).toString(
        'base64url',
      );
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pair.publicKey.export({ format: 'jwk' }) as P256Jwk;
    const claims = {
      ...claimsVector,
      sessionPublicKey: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y },
    };
    const late = { ...env.object, submittedAt: claimsVector.expiresAt + 1 };
    expect(
      problem({ claims, envelope: late, envelopeSignature: resign(late, pair.privateKey), now: late.submittedAt }),
    ).toBe('OUTSIDE_SESSION');
    const early = { ...env.object, submittedAt: claimsVector.issuedAt - 1 };
    expect(problem({ claims, envelope: early, envelopeSignature: resign(early, pair.privateKey) })).toBe(
      'OUTSIDE_SESSION',
    );
    expect(problem({ now: env.object.submittedAt - 61 })).toBe('FUTURE_SUBMISSION');
  });
});

describe('ChallengeCompletion', () => {
  const t = tokenOf('ChallengeCompletion');
  const c = t.claims as {
    userId: string;
    safe: Address;
    safeTxHash: string;
    nonce: number;
    destination: Address;
    token: Address;
    amount: string;
    completedAt: number;
  };
  const expected = {
    type: 'HIGH_VALUE_TX' as const,
    action: 'SEND',
    userId: c.userId,
    safe: c.safe,
    safeTxHash: c.safeTxHash,
    nonce: BigInt(c.nonce),
    destination: c.destination,
    token: c.token,
    amount: BigInt(c.amount),
    now: c.completedAt + 60,
    maxAgeSeconds: 86_400,
    clockSkewSeconds: 60,
  };
  it('el vector coincide con la operación', async () => {
    expect(await verifyChallengeCompletion(t.jws, keysOf(t), expected)).toBe(true);
  });
  const mismatches: [string, Partial<ChallengeExpectation>][] = [
    ['otro tipo', { type: 'WHITELIST_ADD' }],
    ['otra acción', { action: 'SWAP' }],
    ['otro usuario', { userId: crypto.randomUUID() }],
    ['otra Safe', { safe: '0x0000000000000000000000000000000000000abc' }],
    ['otra SafeTx', { safeTxHash: `0x${'22'.repeat(32)}` }],
    ['otro nonce', { nonce: 2n }],
    ['otro destino', { destination: '0x0000000000000000000000000000000000000002' }],
    ['otro token', { token: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' }],
    ['otro monto', { amount: 1n }],
    ['vencida (> 24 h)', { now: c.completedAt + 86_401 }],
    ['completada en el futuro', { now: c.completedAt - 61 }],
  ];
  it.each(mismatches)('no coincide: %s', async (_name, overrides) => {
    expect(await verifyChallengeCompletion(t.jws, keysOf(t), { ...expected, ...overrides })).toBe(false);
  });
  it('firmada por otra clave → no vale', async () => {
    const other = generateKeyPairSync('ed25519');
    expect(await verifyChallengeCompletion(t.jws, pinnedKeys(other.publicKey), expected)).toBe(false);
  });
});

describe('IntegrityAttestation', () => {
  const t = tokenOf('IntegrityAttestation');
  const a = t.claims as { observedAt: number; expiresAt: number };
  const expected = {
    platformId: 'mtw',
    environment: 'staging',
    app: 'WALLET' as const,
    now: a.observedAt + 10,
    clockSkewSeconds: 60,
  };
  it('vigente y OK', async () => {
    expect(await verifyIntegrity(t.jws, keysOf(t), expected)).toBe(true);
  });
  it('ausente, vencida, de otra app o de otro entorno → pausa', async () => {
    expect(await verifyIntegrity(undefined, keysOf(t), expected)).toBe(false);
    expect(await verifyIntegrity(t.jws, keysOf(t), { ...expected, now: a.expiresAt })).toBe(false);
    expect(await verifyIntegrity(t.jws, keysOf(t), { ...expected, app: 'RECOVERY' })).toBe(false);
    expect(await verifyIntegrity(t.jws, keysOf(t), { ...expected, environment: 'production' })).toBe(false);
  });
  it('status MISMATCH firmado por el monitor → pausa', async () => {
    const monitor = generateKeyPairSync('ed25519');
    const mismatch = signJws({ ...t.claims, status: 'MISMATCH' }, monitor.privateKey, ed25519Kid(monitor.publicKey));
    expect(await verifyIntegrity(mismatch, pinnedKeys(monitor.publicKey), expected)).toBe(false);
  });
});

describe('SignerKeyAttestation', () => {
  const t = tokenOf('SignerKeyAttestation');
  const c = t.claims as { walletId: string; executor: Address };
  it('verifica el vector y exige wallet y clave', async () => {
    expect(await verifySignerKeyAttestation(t.jws, keysOf(t), c)).toMatchObject({ shardId: 'dev-1', chainId: 8453 });
    expect(await verifySignerKeyAttestation(t.jws, keysOf(t), { ...c, walletId: crypto.randomUUID() })).toBeUndefined();
    expect(
      await verifySignerKeyAttestation(t.jws, keysOf(t), {
        ...c,
        executor: '0x0000000000000000000000000000000000000abc',
      }),
    ).toBeUndefined();
    expect(await verifySignerKeyAttestation(undefined, keysOf(t), c)).toBeUndefined();
  });
});
