// PlatformSession y envelopes de prueba firmados con claves de prueba: el emisor (Ed25519) firma el token y la session
// key P-256 firma el envelope de envío, igual que el backend y el frontend.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { ed25519Kid, signJws } from '../../src/crypto/jws.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import type { P256Jwk } from '../../src/crypto/p256.ts';
import { submissionCanonical, type SubmissionEnvelope } from '../../src/policy/session.ts';
import type { TestEdKey } from './keys.ts';

export interface SessionKey {
  privateKey: KeyObject;
  jwk: P256Jwk;
}

export function newSessionKey(): SessionKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

export interface SessionParams {
  issuer: TestEdKey;
  sessionKey: SessionKey;
  userId: string;
  walletId: string;
  safe: Address;
  scope?: string;
  issuedAt: number;
  expiresAt?: number;
  aud?: string[];
  platformId?: string;
  sessionId?: string;
}

export function mintSession(p: SessionParams): { token: string; sessionId: string } {
  const sessionId = p.sessionId ?? crypto.randomUUID();
  const claims = {
    userId: p.userId,
    walletId: p.walletId,
    safe: p.safe,
    platformId: p.platformId ?? 'mtw',
    sessionPublicKey: p.sessionKey.jwk,
    sessionId,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt ?? p.issuedAt + 900,
    scope: p.scope ?? 'OPERATIONS',
    authMethod: p.scope === 'RECOVERY' ? 'STEP_UP' : 'OPAQUE_U',
    accountSessionId: crypto.randomUUID(),
    aud: p.aud ?? ['mtw-api', 'mtw-signer'],
  };
  return { token: signJws(claims, p.issuer.privateKey, ed25519Kid(p.issuer.publicKey)), sessionId };
}

export function signEnvelope(sessionKey: SessionKey, envelope: SubmissionEnvelope): string {
  return sign('sha256', Buffer.from(submissionCanonical(envelope)), {
    key: sessionKey.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

export function attest(issuer: TestEdKey, claims: Record<string, unknown>): string {
  return signJws(claims, issuer.privateKey, ed25519Kid(issuer.publicKey));
}
