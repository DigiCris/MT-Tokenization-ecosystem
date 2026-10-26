// Enrollment de R desde el enlace de la Wallet (P19.T03, [F-LNK-01/02], P12): el fragmento `#eid=<uuid>&n=<nonce>&k=<k>`
// (nunca llega a un servidor), el objeto del enrollment firmado por la Enrollment Key (P-256, sobre JCS), la prueba de
// control de R (EIP-712, recupera exactamente R), la KeyAcceptance de R′ en un reemplazo y el enlace de regreso a la
// Wallet con R para que la confirme. `k` es el secreto del pedido que generó la Wallet (ADR-033): Recovery no lo usa ni
// lo manda a su backend, sólo lo devuelve en el fragmento del enlace de regreso, y con él la Wallet sabe que ese enlace
// lo armó esta app a partir de su pedido (un backend comprometido conoce el pedido y su R′, pero nunca `k`). También,
// cuándo vence el pedido y qué queda de R en este dispositivo al enviarla ([F-KEY-07], tercera revisión de P17.MAN).
// Cuarta revisión: el propósito con el que esta app trata el pedido no depende sólo del backend (hallazgo 5) y un envío
// que el backend rechaza por el estado del pedido se explica con el pedido releído (hallazgo 4).
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/client.ts';
import type { EnrollmentObject, EnrollmentStatus, EnrollmentSubmission, StorageFlags } from '../api/recovery-api.ts';
import { canonicalize } from '../api/jcs.ts';
import { signP256 } from '../api/session-key.ts';
import { hexToBytes, bytesToHex } from '../crypto/encoding.ts';
import type { RecoveryEnvelope } from '../crypto/envelope.ts';
import { SUBMIT_REREAD_FAILED_TEXT, SUBMIT_STILL_OPEN_TEXT, type UnusedCause } from './texts.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^0x[0-9a-f]{64}$/;
/** Secreto del pedido: 16 bytes (128 bits) en base64url sin relleno, como lo genera la Wallet. */
const SECRET = /^[A-Za-z0-9_-]{22}$/;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export class EnrollmentError extends Error {
  override name = 'EnrollmentError';
}

export interface EnrollLink {
  enrollmentId: string;
  nonce: Hex;
  /**
   * `k` del enlace de ida (null si no lo trae: la Wallet actual siempre lo manda, así que lo armó una Wallet anterior a
   * ADR-033 o alguien lo sacó del enlace). Sin `k` no hay enlace de regreso: la dirección se copia a mano en la Wallet.
   */
  secret: string | null;
}

/**
 * `#eid=<uuid>&n=<0x + 64 hex>&k=<22 base64url>` del enlace de la Wallet; null si el fragmento no es un pedido válido
 * (también si trae un `k` mal formado). Sin `k` el pedido sigue valiendo, pero la pantalla final no ofrece el enlace de
 * regreso (ver `returnLink`): pide copiar la dirección en la Wallet, en la comparación manual.
 */
export function parseEnrollFragment(fragment: string): EnrollLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const enrollmentId = params.get('eid')?.toLowerCase() ?? '';
  const nonce = params.get('n')?.toLowerCase() ?? '';
  const secret = params.get('k');
  if (!UUID.test(enrollmentId) || !NONCE.test(nonce)) return null;
  if (secret !== null && !SECRET.test(secret)) return null;
  return { enrollmentId, nonce: nonce as Hex, secret };
}

/** La ruta de esta pantalla con el pedido en el fragmento (para volver a ella después de conectar Drive). */
export function enrollReturnPath(link: EnrollLink): string {
  const params = new URLSearchParams({ eid: link.enrollmentId, n: link.nonce });
  if (link.secret !== null) params.set('k', link.secret);
  return `/enroll#${params.toString()}`;
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

/**
 * [F-LNK-02]: enlace de regreso a la Wallet con R en el fragmento, para confirmarla en la pestaña que espera:
 * `…/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>`, con el mismo `k` del enlace de ida. Sin `k` la Wallet no lo
 * acepta: la pestaña del pedido lo toma como un enlace falsificado, cancela el pedido (ya no se confirma por ningún
 * camino, tampoco a mano) y se lo informa a la plataforma (`RETURN_LINK_UNVERIFIED`, con el email de posible
 * sustitución); sin esa pestaña, la que abre el enlace también cancela el pedido. Por eso, con un enlace de ida sin `k`,
 * la pantalla final no lo muestra y pide copiar la dirección en la pestaña del pedido.
 */
export function returnLink(
  walletOrigin: string,
  link: Pick<EnrollLink, 'enrollmentId' | 'secret'>,
  recoveryKey: Address,
): string {
  if (!isAddress(recoveryKey)) throw new EnrollmentError('R inválida');
  const url = new URL('/onboarding/confirm-recovery', walletOrigin);
  const params = new URLSearchParams({ eid: link.enrollmentId, r: getAddress(recoveryKey) });
  if (link.secret !== null) params.set('k', link.secret);
  url.hash = params.toString();
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

/**
 * Cuándo vence el pedido de la Wallet, con la hora que informa el backend (`expiresAt`, 15 minutos desde que la Wallet
 * lo generó, no desde que se abrió acá: puede llegar con pocos minutos), en el huso del dispositivo salvo que se pase
 * otro.
 */
export function requestExpiryText(expiresAt: string, timeZone?: string): string {
  const time = new Date(expiresAt).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return `Este pedido de la app Wallet vence a las ${time}: enviá la dirección antes.`;
}

/** Los sobres recordados en este dispositivo (src/storage/envelope-cache.ts: IndexedDB, uno por clave de cada wallet). */
export interface EnvelopeStore {
  remember: (envelope: RecoveryEnvelope) => Promise<void>;
  forget: (walletId: string) => Promise<void>;
}

/**
 * «Recordar el sobre cifrado de R en este dispositivo» ([F-KEY-07]) al enviar la dirección de una R creada en este
 * navegador: con la casilla marcada se guarda sólo el sobre cifrado (nunca R ni la Password R). Se guarda recién con la
 * dirección enviada, así un pedido que vence o se abandona no deja el sobre de una R que no se va a usar. En el
 * onboarding, antes se borra el que hubiera quedado de un pedido anterior (la wallet todavía no tiene R vigente: era de
 * una R que ya no se usa). En un reemplazo de R nunca se borra nada: el de R′ queda junto al de la R vigente, que hasta
 * que el reemplazo se ejecute (48 h) es la que cancela rotaciones. `purpose` es el propósito efectivo
 * (effectivePurpose), no sólo el que informa el backend. Devuelve si quedó recordado.
 */
export async function keepEnvelopeOnDevice(
  envelope: RecoveryEnvelope,
  choice: { remember: boolean; purpose: EnrollmentStatus['purpose'] },
  store: EnvelopeStore,
): Promise<boolean> {
  if (choice.purpose === 'ONBOARDING') await store.forget(envelope.walletId);
  if (!choice.remember) return false;
  await store.remember(envelope);
  return true;
}

/** Lo que este dispositivo sabe de una wallet: sus sobres recordados y la Safe que verificó cada R (envelope-cache.ts). */
export interface DeviceRecords {
  envelopes: () => Promise<RecoveryEnvelope[]>;
  safeOf: (recoveryKey: Address) => Promise<Address | null>;
}

/**
 * El propósito con el que esta app trata el pedido (hallazgo 5 de la cuarta revisión): reemplazo si el backend lo dice
 * o si este dispositivo recuerda un sobre de esa wallet cuya R tiene una Safe recordada (la que RecoveryGate verificó en
 * Base, con R como clave de recuperación del Guard): esa wallet ya tiene R. Así, un backend que marque como onboarding
 * el reemplazo de una wallet con R no consigue que se borre el sobre de la R vigente ni que se muestren los textos del
 * onboarding. Si el dispositivo no se puede leer, vale lo que dice el backend (tampoco se podría borrar nada).
 */
export async function effectivePurpose(
  enrollment: Pick<EnrollmentStatus, 'purpose' | 'walletId'>,
  device: DeviceRecords,
): Promise<EnrollmentStatus['purpose']> {
  if (enrollment.purpose === 'REPLACEMENT') return 'REPLACEMENT';
  try {
    for (const envelope of await device.envelopes()) {
      if (envelope.walletId !== enrollment.walletId) continue;
      if ((await device.safeOf(envelope.keyAddress)) !== null) return 'REPLACEMENT';
    }
  } catch {
    // Sin IndexedDB (modo privado, datos del sitio bloqueados) no hay sobres recordados que cuidar.
  }
  return 'ONBOARDING';
}

/**
 * Qué pasó con un envío que el backend rechazó por el estado del pedido (CONFLICT), según el pedido releído: ya tiene
 * esta misma R (un envío anterior que sí llegó: se sigue como enviado), esta R no se va a usar (y por qué) o el pedido
 * sigue abierto (se puede reintentar). Una respuesta de otro pedido no dice nada de éste: se trata como abierto.
 */
export type ConflictOutcome = { kind: 'sent' } | { kind: 'unused'; cause: UnusedCause } | { kind: 'open' };

export function conflictOutcome(
  latest: Pick<EnrollmentStatus, 'id' | 'status' | 'recoveryKey' | 'rejectionReason'>,
  enrollmentId: string,
  recoveryKey: Address,
): ConflictOutcome {
  if (latest.id.toLowerCase() !== enrollmentId.toLowerCase()) return { kind: 'open' };
  switch (latest.status) {
    case 'REQUESTED':
      return { kind: 'open' };
    case 'EXPIRED':
      return { kind: 'unused', cause: 'EXPIRED' };
    case 'RETIRED':
      return { kind: 'unused', cause: 'RETIRED' };
    case 'REJECTED':
      return { kind: 'unused', cause: latest.rejectionReason === 'SUPERSEDED' ? 'SUPERSEDED' : 'CANCELLED' };
    case 'SUBMITTED':
    case 'CONFIRMED':
      return latest.recoveryKey !== null &&
        isAddress(latest.recoveryKey, { strict: false }) &&
        isAddressEqual(latest.recoveryKey, recoveryKey)
        ? { kind: 'sent' }
        : { kind: 'unused', cause: 'OTHER_KEY' };
    default:
      // Un estado que esta versión no conoce: no dice nada de esta R.
      return { kind: 'open' };
  }
}

/**
 * Un envío que falló, explicado (hallazgo 4 de la cuarta revisión): vencido, o rechazado por el estado del pedido
 * (CONFLICT) y entonces releído: ya tiene esta R (`sent`, con el pedido releído), esta R no se va a usar (`unused`) o
 * se puede reintentar (`retry`, con un error que se muestra con describeError: nunca un texto del backend ni «recargá
 * la pantalla», que sin el fragmento pierde el pedido). Si la plataforma ya no encuentra el pedido, esta R tampoco se
 * va a usar.
 */
export type SubmitFailure =
  | { kind: 'sent'; latest: EnrollmentStatus }
  | { kind: 'unused'; cause: UnusedCause }
  | { kind: 'retry'; error: unknown };

export async function explainSubmitFailure(
  error: unknown,
  reread: () => Promise<EnrollmentStatus>,
  enrollmentId: string,
  recoveryKey: Address,
): Promise<SubmitFailure> {
  if (!(error instanceof ApiError)) return { kind: 'retry', error };
  if (error.code === 'ENROLLMENT_EXPIRED') return { kind: 'unused', cause: 'EXPIRED' };
  if (error.code !== 'CONFLICT' && error.status !== 409) return { kind: 'retry', error };
  let latest: EnrollmentStatus;
  try {
    latest = await reread();
  } catch (readError) {
    if (readError instanceof ApiError && readError.status === 404) return { kind: 'unused', cause: 'NOT_FOUND' };
    return { kind: 'retry', error: new Error(SUBMIT_REREAD_FAILED_TEXT, { cause: readError }) };
  }
  const outcome = conflictOutcome(latest, enrollmentId, recoveryKey);
  if (outcome.kind === 'sent') return { kind: 'sent', latest };
  if (outcome.kind === 'unused') return outcome;
  return { kind: 'retry', error: new Error(SUBMIT_STILL_OPEN_TEXT, { cause: error }) };
}
