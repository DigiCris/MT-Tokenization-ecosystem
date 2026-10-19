// Enrollment de R desde el link de la Wallet (P19.T03, [F-LNK-01/02], P12): el fragmento `#eid=<uuid>&n=<nonce>`
// (nunca llega a un servidor), el objeto del enrollment firmado por la Enrollment Key (P-256, sobre JCS), la prueba de
// control de R (EIP-712, recupera exactamente R), la KeyAcceptance de R′ en un reemplazo y el link de regreso a la
// Wallet con R para que la confirme.
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import type { EnrollmentObject, EnrollmentSubmission, StorageFlags } from '../api/recovery-api.ts';
import { canonicalize } from '../api/jcs.ts';
import { signP256 } from '../api/session-key.ts';
import { hexToBytes, bytesToHex } from '../crypto/encoding.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^0x[0-9a-f]{64}$/;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export class EnrollmentError extends Error {
  override name = 'EnrollmentError';
}

export interface EnrollLink {
  enrollmentId: string;
  nonce: Hex;
}

/** `#eid=<uuid>&n=<0x + 64 hex>` del link de la Wallet; null si el fragmento no es un pedido válido. */
export function parseEnrollFragment(fragment: string): EnrollLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const enrollmentId = params.get('eid')?.toLowerCase() ?? '';
  const nonce = params.get('n')?.toLowerCase() ?? '';
  if (!UUID.test(enrollmentId) || !NONCE.test(nonce)) return null;
  return { enrollmentId, nonce: nonce as Hex };
}

/** La ruta de esta pantalla con el pedido en el fragmento (para volver a ella después de conectar Drive). */
export function enrollReturnPath(link: EnrollLink): string {
  return `/enroll#${new URLSearchParams({ eid: link.enrollmentId, n: link.nonce }).toString()}`;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Vigencia del objeto firmado: el máximo que acepta el backend (30 min; el enrollment en sí vence antes, a los 15). */
export const ENROLLMENT_OBJECT_TTL_MS = 30 * 60_000;

/** Objeto del enrollment, válido desde 1 s antes de ahora (el backend tolera hasta 60 s de diferencia de reloj). */
export function enrollmentObject(input: {
  userId: string;
  platformId: string;
  recoveryKey: Address;
  nonce: Hex;
  nowMs: number;
}): EnrollmentObject {
  const issuedAt = new Date(input.nowMs - 1_000);
  return {
    userId: input.userId,
    platformId: input.platformId,
    R: getAddress(input.recoveryKey),
    nonce: input.nonce,
    issuedAt: isoSeconds(issuedAt),
    expiresAt: isoSeconds(new Date(issuedAt.getTime() + ENROLLMENT_OBJECT_TTL_MS)),
  };
}

/** Firma de la Enrollment Key: P-256 sobre los bytes UTF-8 del JCS del objeto, sin prefijo. */
export function signEnrollmentObject(enrollmentKey: CryptoKey, object: EnrollmentObject): Promise<string> {
  return signP256(enrollmentKey, canonicalize({ ...object }));
}

/**
 * Firma ECDSA en el formato estricto que exigen backend y signer: 65 bytes, v ∈ {27, 28} y s en la mitad baja. Las
 * wallets externas pueden devolver v = 0/1 o una s alta (válida pero maleable): se normalizan sin cambiar el firmante.
 */
export function strictSignature(signature: Hex): Hex {
  if (!isHexSignature(signature)) throw new EnrollmentError('la firma no tiene 65 bytes');
  const bytes = hexToBytes(signature, 65);
  let v = bytes[64] ?? 0;
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new EnrollmentError('la firma tiene un v inválido');
  const s = BigInt(bytesToHex(bytes.slice(32, 64)));
  if (s === 0n || s >= SECP256K1_N) throw new EnrollmentError('la firma tiene una s inválida');
  if (s > SECP256K1_N / 2n) {
    const low = hexToBytes(`0x${(SECP256K1_N - s).toString(16).padStart(64, '0')}`, 32);
    bytes.set(low, 32);
    v = v === 27 ? 28 : 27;
  }
  bytes[64] = v;
  return bytesToHex(bytes);
}

function isHexSignature(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{130}$/.test(value);
}

export function submission(input: {
  object: EnrollmentObject;
  enrollmentKeySignature: string;
  proofOfControl: Hex;
  external: { connectorId: string } | null;
  storageFlags: StorageFlags | null;
  keyAcceptance: { nonce: Hex; signature: Hex } | null;
}): EnrollmentSubmission {
  if (input.external === null && input.storageFlags === null) {
    throw new EnrollmentError('una R interna necesita sus backups');
  }
  if (input.storageFlags !== null && !input.storageFlags.file && !input.storageFlags.qr && !input.storageFlags.words) {
    throw new EnrollmentError('R necesita al menos un backup que no dependa de la plataforma (archivo, QR o palabras)');
  }
  return {
    enrollment: input.object,
    enrollmentKeySignature: input.enrollmentKeySignature,
    rType: input.external === null ? 'INTERNAL' : 'EXTERNAL',
    proofOfControl: strictSignature(input.proofOfControl),
    ...(input.external === null ? {} : { connectorId: input.external.connectorId }),
    ...(input.storageFlags === null ? {} : { storageFlags: input.storageFlags }),
    ...(input.keyAcceptance === null
      ? {}
      : {
          keyAcceptance: {
            nonce: input.keyAcceptance.nonce,
            signature: strictSignature(input.keyAcceptance.signature),
          },
        }),
  };
}

/** [F-LNK-02]: link de regreso a la Wallet con R en el fragmento, para confirmarla en la pestaña que espera. */
export function returnLink(walletOrigin: string, enrollmentId: string, recoveryKey: Address): string {
  if (!isAddress(recoveryKey)) throw new EnrollmentError('R inválida');
  const url = new URL('/onboarding/confirm-recovery', walletOrigin);
  url.hash = new URLSearchParams({ eid: enrollmentId, r: getAddress(recoveryKey) }).toString();
  return url.toString();
}

/** Id del conector externo como lo acepta el backend (`[a-z0-9][a-z0-9.-]{1,62}`). */
export function connectorIdFor(id: string): string {
  const normalized = id
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(normalized)) throw new EnrollmentError('conector inválido');
  return normalized;
}
