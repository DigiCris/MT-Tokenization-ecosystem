// SignerKeyAttestation ([B-SIG-07], [W-03], [F-SEC-08]) en Recovery: JWS compacto EdDSA firmado por la clave de
// atestación del signer cuyo SPKI viene fijado en el build. Ata una S (executor) a una wallet y una cadena: Recovery la
// verifica antes de proponer una rotación hacia una S′ o de armar un reemplazo soberano de S con la S′ de la plataforma.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import { base64UrlToBytes, fromUtf8, toBufferSource, utf8 } from './encoding.ts';

export interface SignerKeyAttestation {
  walletId: string;
  shardId: string;
  executor: Address;
  chainId: 8453;
  issuedAt: number;
}

export class AttestationError extends Error {
  override name = 'AttestationError';
}

function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Clave pública Ed25519 fijada: SPKI DER en base64 (44 bytes, prefijo fijo de 12). */
export async function importAttestationKey(spkiBase64: string): Promise<CryptoKey> {
  const der = base64ToBytes(spkiBase64);
  if (der.length !== 44) throw new AttestationError('la clave de atestación fijada no es Ed25519');
  return crypto.subtle.importKey('spki', toBufferSource(der), { name: 'Ed25519' }, false, ['verify']);
}

function json(segment: string): unknown {
  try {
    return JSON.parse(fromUtf8(base64UrlToBytes(segment)));
  } catch {
    throw new AttestationError('la atestación no es un JWS válido');
  }
}

/** Verifica la firma con la clave fijada y que la atestación sea de esa wallet y esa S en Base. */
export async function verifySignerKeyAttestation(
  jws: string,
  key: CryptoKey,
  expected: { walletId: string; executor: Address },
): Promise<SignerKeyAttestation> {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new AttestationError('la atestación no es un JWS compacto');
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = json(headerPart) as { alg?: unknown; kid?: unknown };
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || header.kid === '') {
    throw new AttestationError('la atestación no es EdDSA con kid');
  }
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signaturePart, 64);
  } catch {
    throw new AttestationError('firma de la atestación inválida');
  }
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    toBufferSource(signature),
    toBufferSource(utf8(`${headerPart}.${payloadPart}`)),
  );
  if (!valid) throw new AttestationError('la atestación no está firmada por el signer de esta versión');
  const payload = json(payloadPart) as Record<string, unknown>;
  const { walletId, shardId, executor, chainId, issuedAt } = payload;
  if (
    typeof walletId !== 'string' ||
    typeof shardId !== 'string' ||
    typeof executor !== 'string' ||
    !isAddress(executor) ||
    chainId !== 8453 ||
    typeof issuedAt !== 'number'
  ) {
    throw new AttestationError('contenido de la atestación inválido');
  }
  if (walletId !== expected.walletId) throw new AttestationError('la atestación es de otra wallet');
  if (!isAddressEqual(executor, expected.executor)) throw new AttestationError('la atestación es de otra clave S');
  return { walletId, shardId, executor: getAddress(executor), chainId: 8453, issuedAt };
}
