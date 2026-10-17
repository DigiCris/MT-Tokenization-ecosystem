// Session key P-256 [B-PSES-01]/[W-02]: JWK pública estricta y verificación ECDSA P-256 (SHA-256, IEEE P1363 r‖s de 64
// bytes en base64url) sobre los bytes UTF-8 del mensaje, como la firma WebCrypto del frontend.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export const P256JwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(B64URL_32),
    y: z.string().regex(B64URL_32),
  })
  .strict()
  .refine((jwk) => {
    try {
      createPublicKey({ key: jwk, format: 'jwk' });
      return true;
    } catch {
      return false;
    }
  }, 'punto P-256 inválido');
export type P256Jwk = z.infer<typeof P256JwkSchema>;

export function p256Key(jwk: P256Jwk): KeyObject {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Thumbprint RFC 7638 (SHA-256, base64url) de una JWK P-256. */
export function p256Thumbprint(jwk: P256Jwk): string {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

export function verifyP256(jwk: P256Jwk, message: string, signatureB64url: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureB64url)) return false;
  try {
    return verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key: p256Key(jwk), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64url, 'base64url'),
    );
  } catch {
    return false;
  }
}
