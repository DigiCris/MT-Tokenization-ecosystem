// Session key P-256 de la PlatformSession y Enrollment Key ([B-PSES-05], [W-02]): ECDSA P-256 de WebCrypto con la
// privada no extraíble (vive sólo en memoria), la pública como JWK {kty, crv, x, y}, su thumbprint RFC 7638 y firmas
// IEEE P1363 (r ‖ s, 64 bytes) en base64url sobre los bytes UTF-8 del mensaje.
import { base64UrlToBytes, bytesToBase64Url, toBufferSource, utf8 } from '../crypto/encoding.ts';

export interface P256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface SessionKey {
  privateKey: CryptoKey;
  publicJwk: P256PublicJwk;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function generateSessionKey(): Promise<SessionKey> {
  const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('la clave pública P-256 no tiene x/y');
  return { privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

/** RFC 7638: SHA-256 del JSON con las claves requeridas en orden lexicográfico, en base64url. */
export async function jwkThumbprint(jwk: P256PublicJwk): Promise<string> {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(utf8(canonical)))));
}

export async function signP256(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(SIGN, privateKey, toBufferSource(utf8(message)));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Verificación (para los vectores y los tests: el backend es quien verifica en producción). */
export async function verifyP256(jwk: P256PublicJwk, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, ECDSA, false, ['verify']);
  return crypto.subtle.verify(
    SIGN,
    key,
    toBufferSource(base64UrlToBytes(signature, 64)),
    toBufferSource(utf8(message)),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(utf8(text))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
