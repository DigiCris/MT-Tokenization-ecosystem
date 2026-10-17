// Atestaciones JWS [W-03]: compactas, `alg: EdDSA` (Ed25519), `kid` obligatorio. El signer verifica contra claves
// públicas FIJADAS en su configuración (emisor de sesiones, integrity monitor, su propia clave de atestación) y emite
// las suyas (SignerKeyAttestation) con header y payload en JSON canónico.
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { compactVerify } from 'jose';
import { canonicalJson } from './jcs.ts';

export class JwsError extends Error {
  override name = 'JwsError';
}

/** Clave Ed25519 pública desde SPKI DER en base64 (formato de `pnpm secrets:local`). */
export function ed25519PublicKey(spkiBase64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('se esperaba una clave Ed25519');
  return key;
}

export function ed25519PrivateKey(pkcs8Base64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('se esperaba una clave Ed25519');
  return key;
}

/** kid = thumbprint RFC 7638 de la clave pública Ed25519 (igual que el emisor de sesiones del backend). */
export function ed25519Kid(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (jwk.x === undefined) throw new TypeError('clave Ed25519 sin x');
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`).digest('base64url');
}

export type PinnedKeys = ReadonlyMap<string, KeyObject>;

export function pinnedKeys(...keys: KeyObject[]): PinnedKeys {
  return new Map(keys.map((k) => [ed25519Kid(k), k]));
}

/** Verifica un JWS compacto EdDSA con una de las claves fijadas (por `kid`) y devuelve el payload JSON. */
export async function verifyJws(token: string, keys: PinnedKeys): Promise<{ kid: string; payload: unknown }> {
  if (typeof token !== 'string' || token.length > 8_192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new JwsError('JWS mal formado');
  }
  let header: { alg?: unknown; kid?: unknown; crit?: unknown };
  try {
    header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as typeof header;
  } catch {
    throw new JwsError('header ilegible');
  }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || header.crit !== undefined) {
    throw new JwsError('header no permitido');
  }
  const key = keys.get(header.kid);
  if (key === undefined) throw new JwsError('kid desconocido');
  try {
    const { payload } = await compactVerify(token, key, { algorithms: ['EdDSA'] });
    return { kid: header.kid, payload: JSON.parse(Buffer.from(payload).toString('utf8')) as unknown };
  } catch {
    throw new JwsError('firma JWS inválida');
  }
}

/** JWS compacto EdDSA con header `{alg, kid, typ: 'JWT'}` y payload en JSON canónico. */
export function signJws(claims: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = Buffer.from(canonicalJson({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(canonicalJson(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
