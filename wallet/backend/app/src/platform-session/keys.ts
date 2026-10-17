// Session keys de PlatformSession [B-PSES-02/05], [W-02]: ECDSA P-256 generada en el navegador con WebCrypto
// (`extractable=false`); el servidor sólo conoce la JWK pública. Firmas IEEE P1363 (r‖s, 64 bytes, base64url) sobre los
// bytes UTF-8 del mensaje con SHA-256.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** JWK pública P-256 (sólo los campos de una clave pública: sin `d`, sin parámetros extra). */
export const P256PublicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(B64URL_32, { error: 'coordenada x de 32 bytes en base64url' }),
    y: z.string().regex(B64URL_32, { error: 'coordenada y de 32 bytes en base64url' }),
  })
  .strict()
  // El punto tiene que estar en la curva (si no, ninguna firma podría verificarse con esa clave).
  .refine(
    (jwk) => {
      try {
        createPublicKey({ key: jwk, format: 'jwk' });
        return true;
      } catch {
        return false;
      }
    },
    { error: 'la clave no es un punto P-256 válido' },
  )
  .meta({ id: 'SessionPublicKey', description: 'Clave pública P-256 de la session key (JWK)' });

export type P256PublicJwk = z.infer<typeof P256PublicJwkSchema>;

/** Clave pública de la JWK; falla si el punto no está en la curva. */
export function sessionPublicKey(jwk: P256PublicJwk): KeyObject {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Thumbprint RFC 7638 (base64url de SHA-256 del JSON con crv, kty, x, y en ese orden). */
export function jwkThumbprint(jwk: P256PublicJwk): string {
  return createHash('sha256')
    .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`, 'utf8')
    .digest('base64url');
}

/** Verifica una firma ECDSA P-256/SHA-256 IEEE P1363 en base64url; false ante cualquier formato inválido. */
export function verifyP256(jwk: P256PublicJwk, message: string, signature: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key: sessionPublicKey(jwk), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
