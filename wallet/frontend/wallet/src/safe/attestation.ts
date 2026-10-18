// SignerKeyAttestation de S ([B-SIG-07], [F-SEC-08]): JWS compacto EdDSA (Ed25519) que emite el signer al crear la
// clave, con payload JCS {chainId, executor, issuedAt, shardId, walletId}. La app lo verifica con la clave pública de
// atestación embebida en el build (system-contracts.<env>.json): sin una atestación válida para esa wallet y esa
// dirección no acepta la S que informe el backend (P18.T01) ni la S′ de una rotación pedida por la plataforma
// (P18.T09.b). Nunca se confía en el `kid`: sólo en la clave fijada.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import { fromBase64Url, ownBuffer, utf8 } from '../crypto/bytes.ts';
import { canonicalize, type Json } from '../api/jcs.ts';

export interface SignerKeyClaims {
  walletId: string;
  shardId: string;
  executor: Address;
  chainId: number;
  issuedAt: number;
}

export class AttestationError extends Error {
  override name = 'AttestationError';
}

function parseJson(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as unknown;
  } catch {
    throw new AttestationError('Atestación de la clave de la plataforma mal formada');
  }
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function verifySignerKeyAttestation(
  jws: string,
  publicKeySpkiBase64: string,
  expected: { walletId: string; executor: Address; chainId?: number },
): Promise<SignerKeyClaims> {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    throw new AttestationError('Atestación de la clave de la plataforma mal formada');
  }
  const [header, payload, signature] = parts as [string, string, string];
  const head = parseJson(header) as { alg?: unknown; typ?: unknown };
  if (head.alg !== 'EdDSA' || head.typ !== 'JWT') throw new AttestationError('Atestación con un algoritmo inesperado');
  const key = await crypto.subtle.importKey(
    'spki',
    ownBuffer(fromBase64(publicKeySpkiBase64)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    ownBuffer(fromBase64Url(signature)),
    ownBuffer(utf8(`${header}.${payload}`)),
  );
  if (!valid) throw new AttestationError('La clave de la plataforma no está atestada por el signer de esta versión');
  const claims = parseJson(payload) as Record<string, Json>;
  // El payload es JCS: cualquier otra serialización es una atestación que no emitió el signer.
  let canonical: string;
  try {
    canonical = canonicalize(claims);
  } catch {
    throw new AttestationError('Atestación de la clave de la plataforma mal formada');
  }
  if (new TextDecoder().decode(fromBase64Url(payload)) !== canonical) {
    throw new AttestationError('Atestación de la clave de la plataforma mal formada');
  }
  const { walletId, shardId, executor, chainId, issuedAt } = claims;
  if (
    typeof walletId !== 'string' ||
    typeof shardId !== 'string' ||
    typeof executor !== 'string' ||
    !isAddress(executor) ||
    typeof chainId !== 'number' ||
    typeof issuedAt !== 'number'
  ) {
    throw new AttestationError('Atestación de la clave de la plataforma incompleta');
  }
  if (walletId !== expected.walletId) throw new AttestationError('La atestación es de otra wallet');
  if (!isAddressEqual(executor, expected.executor)) throw new AttestationError('La atestación es de otra clave');
  if (chainId !== (expected.chainId ?? 8453)) throw new AttestationError('La atestación es de otra red');
  return { walletId, shardId, executor: getAddress(executor), chainId, issuedAt };
}
