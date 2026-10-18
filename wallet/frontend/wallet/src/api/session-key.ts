// Session key de la PlatformSession ([B-PSES-02], [W-02]): par ECDSA P-256 de WebCrypto con la privada **no
// exportable**; viaja sólo la pública como JWK {kty, crv, x, y}. Firma P1363 (r ‖ s, 64 bytes) en base64url sobre los
// bytes UTF-8 del mensaje. El binding con OPAQUE es base64url(HMAC-SHA256(sessionKey de OPAQUE, thumbprint ‖
// loginAttemptId)) con el thumbprint RFC 7638 de la JWK. Vectores: test/vectors/wire/{p256,session-binding}.json.
import { fromBase64Url, ownBuffer, toBase64Url, utf8 } from '../crypto/bytes.ts';

export interface P256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface SessionKey {
  /** No exportable: sólo firma. */
  privateKey: CryptoKey;
  publicJwk: P256PublicJwk;
  thumbprint: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(bytes)));
}

/** RFC 7638: SHA-256 del JSON con las claves requeridas en orden lexicográfico, en base64url. */
export async function jwkThumbprint(jwk: P256PublicJwk): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return toBase64Url(await sha256(utf8(canonical)));
}

function isCoordinate(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function generateSessionKey(): Promise<SessionKey> {
  const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !isCoordinate(exported.x) || !isCoordinate(exported.y)) {
    throw new Error('la session key exportó una JWK inesperada');
  }
  const publicJwk: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  return { privateKey: pair.privateKey, publicJwk, thumbprint: await jwkThumbprint(publicJwk) };
}

export async function signP256(privateKey: CryptoKey, message: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, ownBuffer(utf8(message)))));
}

export async function verifyP256(jwk: P256PublicJwk, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, ECDSA, false, ['verify']);
  return crypto.subtle.verify(SIGN, key, ownBuffer(fromBase64Url(signature)), ownBuffer(utf8(message)));
}

/** [B-PSES-02]: ata la session key al login OPAQUE (la clave de sesión de OPAQUE nunca sale del navegador). */
export async function sessionKeyBinding(
  opaqueSessionKey: string,
  thumbprint: string,
  loginAttemptId: string,
): Promise<string> {
  const raw = fromBase64Url(opaqueSessionKey);
  try {
    const key = await crypto.subtle.importKey('raw', ownBuffer(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const mac = await crypto.subtle.sign('HMAC', key, ownBuffer(utf8(`${thumbprint}${loginAttemptId}`)));
    return toBase64Url(new Uint8Array(mac));
  } finally {
    raw.fill(0);
  }
}
