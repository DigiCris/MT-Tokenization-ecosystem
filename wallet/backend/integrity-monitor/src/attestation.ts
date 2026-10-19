// IntegrityAttestation ([W-03]): JWS compacto `alg: EdDSA` con `kid` (thumbprint RFC 7638 de la clave pública, igual
// que el signer y el emisor de sesiones), header y payload en JSON canónico, firmado con la clave de atestación propia
// del monitor. Payload `{platformId, app, environment, releaseId, manifestSha256, status, observedAt, expiresAt}`
// (segundos Unix; `manifestSha256` con 0x). La pública la fijan el signer (INTEGRITY_MONITOR_PUBLIC_KEY) y el backend.
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { App, Status } from './check.ts';
import { canonicalize } from './jcs.ts';

export type AttestationEnvironment = 'local' | 'staging' | 'production';

export interface IntegrityAttestation {
  platformId: string;
  app: App;
  environment: AttestationEnvironment;
  releaseId: string;
  manifestSha256: string;
  status: Status;
  observedAt: number;
  expiresAt: number;
}

export function ed25519Kid(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (jwk.x === undefined) throw new TypeError('clave Ed25519 sin x');
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`).digest('base64url');
}

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

export function signAttestation(payload: IntegrityAttestation, privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('la clave de atestación debe ser Ed25519');
  const header = { alg: 'EdDSA', kid: ed25519Kid(createPublicKey(privateKey)), typ: 'JWT' };
  const signingInput = `${b64url(canonicalize(header))}.${b64url(canonicalize({ ...payload }))}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

/** Verificación (tests y `check-once`): firma con la pública dada, header permitido y payload completo. */
export function verifyAttestation(token: string, publicKey: KeyObject): IntegrityAttestation | null {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) return null;
  if (!verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) return null;
  const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (parsedHeader.alg !== 'EdDSA' || parsedHeader.kid !== ed25519Kid(publicKey)) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IntegrityAttestation;
}
