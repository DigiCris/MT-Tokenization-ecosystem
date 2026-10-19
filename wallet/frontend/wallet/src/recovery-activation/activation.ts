// Activar Recovery (P18.T01, [F-LNK-01/02], ADR-033): la Wallet pide un enrollment, se lo pasa a la app Recovery por un
// enlace cuyo fragmento (que no llega a ningún servidor) lleva el id, el nonce y un secreto `k` nuevo por pedido —también
// como QR—, espera a que Recovery informe la dirección de R y la confirma: con el fragmento del enlace de regreso (que
// tiene que traer el mismo `k`, y `r` tiene que ser exactamente la R que informa el backend; si no, se aborta) o, si el
// usuario usó otro dispositivo sin enlace, con una comparación manual de la dirección completa (los 10 grupos de 4
// caracteres, copiados de la pantalla de Recovery) antes de que U firme nada. `k` lo genera la Wallet, vive sólo en la
// memoria de la pestaña del pedido y nunca va a un servidor: un backend comprometido conoce el pedido y su R′, pero no
// puede armar un enlace de regreso que la Wallet acepte. La Wallet no muestra la R del backend hasta que coincide, así
// que no se la puede copiar de su propia pantalla; la comparación manual tiene 3 intentos por pedido y, al agotarse, el
// pedido se aborta como con un enlace de regreso distinto. Todo aborto se informa al backend (N10) para que quede
// auditado y el usuario reciba la alerta (abort-reports.ts). Revisión de seguridad de ADR-033 (MEDIO 2): en este paso
// no se muestra ningún texto de la plataforma; con el `k` del pedido, cualquier respuesta que no confirme exactamente
// la R del enlace aborta el pedido (sólo un error de red deja reintentar).
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';
import { randomBytes, toBase64Url } from '../crypto/bytes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `k`: 16 bytes (128 bits) del CSPRNG en base64url sin relleno. */
const SECRET = /^[A-Za-z0-9_-]{22}$/;
const SECRET_BYTES = 16;

/** Grupos de 4 caracteres de una dirección (sus 40 caracteres hexadecimales, sin el 0x). */
export const ADDRESS_GROUPS = 10;
/** Intentos de la comparación manual por pedido. */
export const MANUAL_ATTEMPTS = 3;
/** Con a lo sumo estos grupos coincidentes, no parece un error de tipeo. */
const NEARLY_NONE = 2;

export class RecoveryActivationError extends Error {
  override name = 'RecoveryActivationError';
}

/** Motivo con el que la Wallet aborta un pedido y se lo informa al backend (POST /recovery/enrollments/{id}/reject). */
export type RejectReason = 'MANUAL_COMPARISON_FAILED' | 'RETURN_LINK_KEY_MISMATCH' | 'RETURN_LINK_UNVERIFIED';

/** El pedido no se puede confirmar y se aborta (se pide otro enrollment). */
export class RecoveryAbortError extends RecoveryActivationError {
  override name = 'RecoveryAbortError';
  readonly reason: RejectReason;

  constructor(message: string, reason: RejectReason) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Con el `k` del pedido, la plataforma no informa para ese pedido exactamente la R del enlace (otra R, otro pedido,
 * ninguna R, otro estado o un error): la activación se aborta y se pide otro enrollment. Revisión de ADR-033 (MEDIO 2):
 * nada de lo que respondió la plataforma se muestra.
 */
export class RecoveryKeyMismatchError extends RecoveryAbortError {
  override name = 'RecoveryKeyMismatchError';

  constructor() {
    super(
      'La plataforma no informa para este pedido la dirección que trae el enlace de tu app Recovery: alguien pudo haberla cambiado en el camino. Se canceló este pedido.',
      'RETURN_LINK_KEY_MISMATCH',
    );
  }
}

/** Un enlace de regreso sin el secreto del pedido, o con otro: no lo armó la app Recovery a partir de este pedido. */
export class ReturnLinkUnverifiedError extends RecoveryAbortError {
  override name = 'ReturnLinkUnverifiedError';

  constructor() {
    super(
      'Se abrió un enlace de regreso que no armó tu app Recovery para este pedido: alguien pudo haberlo falsificado para hacerte confirmar otra clave R. Se canceló este pedido. No abras enlaces de regreso que te lleguen por email o por chat.',
      'RETURN_LINK_UNVERIFIED',
    );
  }
}

/** Secreto `k` nuevo para un pedido (ADR-033): sólo viaja en los fragmentos de los enlaces de ida y de regreso. */
export function newReturnSecret(random: (length: number) => Uint8Array = randomBytes): string {
  return toBase64Url(random(SECRET_BYTES));
}

/** Compara `k` en tiempo constante (el largo es público: 22 caracteres); sin `k` nunca coincide. */
export function sameSecret(expected: string, received: string | null): boolean {
  if (received === null || received.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return difference === 0;
}

/** [F-LNK-01]: `https://recovery…/enroll#eid=<enrollmentId>&n=<nonce>&k=<secreto del pedido>`. */
export function recoveryEnrollLink(
  recoveryOrigin: string,
  enrollment: Pick<CreatedEnrollment, 'enrollmentId' | 'nonce'>,
  secret: string,
) {
  if (!SECRET.test(secret)) throw new RecoveryActivationError('secreto del pedido inválido');
  const url = new URL('/enroll', recoveryOrigin);
  url.hash = new URLSearchParams({ eid: enrollment.enrollmentId, n: enrollment.nonce, k: secret }).toString();
  return url.toString();
}

export interface RecoveryReturn {
  enrollmentId: string;
  recoveryKey: Address;
  /** `k` del enlace (null si no lo trae o no tiene la forma de uno: entonces no lo armó la app Recovery). */
  secret: string | null;
}

/** [F-LNK-02]: fragmento del enlace de regreso `…/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>`. */
export function parseRecoveryReturn(fragment: string): RecoveryReturn | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const eid = params.get('eid');
  const r = params.get('r');
  const k = params.get('k');
  if (eid === null || r === null || !UUID.test(eid) || !isAddress(r)) return null;
  return {
    enrollmentId: eid.toLowerCase(),
    recoveryKey: getAddress(r),
    secret: k !== null && SECRET.test(k) ? k : null,
  };
}

/** R que informó Recovery para este enrollment (o null mientras no llegó); falla si el enrollment ya no sirve. */
export function submittedRecoveryKey(enrollment: RecoveryEnrollment): Address | null {
  if (enrollment.status === 'EXPIRED' || enrollment.status === 'REJECTED' || enrollment.status === 'RETIRED') {
    throw new RecoveryActivationError('El pedido a Recovery venció o fue reemplazado: generá uno nuevo.');
  }
  if (enrollment.status === 'REQUESTED' || enrollment.recoveryKey === null) return null;
  return getAddress(enrollment.recoveryKey);
}

/**
 * Con enlace de regreso: tiene que traer el mismo `k` del pedido (si no, no lo armó la app Recovery: se aborta). Con el
 * `k`, el enlace es auténtico y lo único que confirma R es que la plataforma informe ese mismo pedido SUBMITTED con
 * exactamente esa R; cualquier otra respuesta (otra R, otro pedido, sin R, otro estado) aborta igual que otra R.
 */
export function confirmWithReturnLink(
  enrollment: RecoveryEnrollment,
  fromLink: RecoveryReturn,
  secret: string,
): Address {
  if (!sameSecret(secret, fromLink.secret)) throw new ReturnLinkUnverifiedError();
  if (
    enrollment.id.toLowerCase() !== fromLink.enrollmentId.toLowerCase() ||
    enrollment.status !== 'SUBMITTED' ||
    enrollment.recoveryKey === null ||
    !isAddress(enrollment.recoveryKey) ||
    !isAddressEqual(fromLink.recoveryKey, enrollment.recoveryKey)
  ) {
    throw new RecoveryKeyMismatchError();
  }
  return getAddress(enrollment.recoveryKey);
}

/** El pedido ya no sirve según la plataforma (vencido, cancelado, reemplazado o terminado): qué pasó, en texto local. */
export function endedRequestText(enrollment: Pick<RecoveryEnrollment, 'status' | 'rejectionReason'>): string | null {
  switch (enrollment.status) {
    case 'REQUESTED':
    case 'SUBMITTED':
      return null;
    case 'EXPIRED':
      return 'El pedido venció antes de que Recovery informara la dirección de tu clave R.';
    case 'REJECTED':
      return enrollment.rejectionReason === 'SUPERSEDED'
        ? 'Este pedido quedó reemplazado por otro más nuevo (generado en otra pestaña o en otro dispositivo).'
        : 'Este pedido se canceló (desde otra pestaña o dispositivo, o porque no se pudo confirmar la dirección de tu clave R).';
    case 'CONFIRMED':
    case 'RETIRED':
      return 'Este pedido ya no está vigente.';
  }
}

/** La pestaña del pedido no pudo consultar a la plataforma para comprobar un enlace de regreso auténtico. */
export const RETURN_LINK_NETWORK_TEXT =
  'No se pudo consultar a la plataforma para comprobar el enlace de regreso: revisá tu conexión y abrí el enlace otra vez (o confirmá la dirección a mano).';

/** Mientras se espera a Recovery: un error de la consulta, sin ningún texto de la plataforma (ui/errors.ts). */
export const POLL_ERROR_TEXT =
  'No se pudo consultar el estado del pedido a la plataforma: se sigue intentando. Revisá tu conexión.';

/** Dirección en grupos de 4 caracteres hexadecimales (sin el 0x), como la muestran las dos apps. */
export function addressGroups(address: Address): string[] {
  return getAddress(address).slice(2).match(/.{4}/g) ?? [];
}

/** Un grupo tipeado en su forma comparable: sin espacios y en minúsculas (da igual cómo se haya escrito). */
function comparableGroup(value: string | undefined): string {
  return (value ?? '').replace(/\s/g, '').toLowerCase();
}

/**
 * Lo que se pegó en el grupo `index`, repartido en los grupos (los campos aceptan 4 caracteres): la dirección completa
 * (con o sin 0x y espacios, como la copia o la muestra Recovery) llena los 10 desde el primero; un pedazo más largo que
 * un grupo sigue desde ese campo. null si entra en el campo (se pega como siempre).
 */
export function distributePaste(current: readonly string[], index: number, pasted: string): string[] | null {
  const compact = pasted.replace(/\s/g, '').replace(/^0x/i, '');
  if (compact.length <= 4) return null;
  const chunks = compact.match(/.{1,4}/g) ?? [];
  const start = compact.length === ADDRESS_GROUPS * 4 ? 0 : index;
  return current.map((value, i) => (i >= start && i - start < chunks.length ? (chunks[i - start] ?? '') : value));
}

/**
 * Un intento de la comparación manual: la R confirmada o, si no coincide, qué grupos fallaron (posiciones desde 0) y
 * cuántos intentos le quedan a ese pedido (0: queda abortado). Nunca dice qué caracteres se esperaban.
 */
export type ManualAttempt =
  { match: true; recoveryKey: Address } | { match: false; mismatchedGroups: number[]; attemptsLeft: number };

/**
 * Sin enlace: la dirección completa copiada de la app Recovery —los 10 grupos, sin distinguir mayúsculas— tiene que
 * coincidir con la R del backend. `failedAttempts`: intentos fallidos anteriores de este mismo pedido.
 */
export function compareManually(
  enrollment: RecoveryEnrollment,
  typed: readonly string[],
  failedAttempts: number,
): ManualAttempt {
  const reported = submittedRecoveryKey(enrollment);
  if (reported === null) throw new RecoveryActivationError('Recovery todavía no informó la dirección de tu clave R.');
  if (failedAttempts >= MANUAL_ATTEMPTS) {
    throw new RecoveryActivationError('Este pedido ya se canceló: generá uno nuevo.');
  }
  // Un grupo que falta cuenta como distinto.
  const mismatchedGroups = addressGroups(reported).flatMap((group, i) =>
    comparableGroup(typed[i]) === group.toLowerCase() ? [] : [i],
  );
  if (mismatchedGroups.length === 0) return { match: true, recoveryKey: reported };
  return { match: false, mismatchedGroups, attemptsLeft: MANUAL_ATTEMPTS - failedAttempts - 1 };
}

/** «el grupo 6» o «los grupos 2, 5 y 9» (las posiciones van desde 0 y se muestran desde 1). */
export function groupsText(positions: readonly number[]): string {
  const shown = positions.map((p) => String(p + 1));
  if (shown.length <= 1) return `el grupo ${shown[0] ?? ''}`;
  return `los grupos ${shown.slice(0, -1).join(', ')} y ${shown.at(-1) ?? ''}`;
}

/** La comparación manual no coincide: puede ser un error de tipeo o una R cambiada en el camino. */
export const MANUAL_MISMATCH_TEXT =
  'No coincide con la dirección que recibió la plataforma. Si la copiaste bien de Recovery, no sigas: alguien pudo haberla cambiado. Generá un pedido nuevo.';

/**
 * Qué revisar si fue un error de tipeo y cuántos intentos le quedan al pedido; si no coincide ningún grupo (o casi
 * ninguno), no parece un error de tipeo y se recomienda no seguir.
 */
export function manualRetryText(mismatchedGroups: readonly number[], attemptsLeft: number): string {
  const matching = ADDRESS_GROUPS - mismatchedGroups.length;
  if (matching <= NEARLY_NONE) {
    const which =
      matching === 0
        ? 'No coincide ningún grupo'
        : `Coincide${matching === 1 ? ' sólo 1 grupo' : `n sólo ${String(matching)} grupos`} de ${String(ADDRESS_GROUPS)}`;
    return `${which}: no parece un error de tipeo. No sigas con este pedido: generá uno nuevo.`;
  }
  const left = attemptsLeft === 1 ? 'te queda 1 intento' : `te quedan ${String(attemptsLeft)} intentos`;
  const separator = mismatchedGroups.length > 1 ? ',' : '';
  return `Si te equivocaste al copiar, revisá ${groupsText(mismatchedGroups)}${separator} y volvé a confirmar (${left}).`;
}

/** Se agotaron los intentos de la comparación manual: el pedido se aborta. */
export const MANUAL_ABORT_TEXT = `La dirección no coincidió con la que recibió la plataforma en ${String(MANUAL_ATTEMPTS)} intentos: se canceló este pedido. Si la copiaste bien de Recovery, alguien pudo haberla cambiado en el camino.`;

/** El enlace de regreso trae un `k`, pero la pestaña que lo abrió no tiene el pedido para comprobarlo. */
export const RETURN_LINK_ELSEWHERE_TEXT =
  'Este enlace de regreso no se puede comprobar en esta pestaña: sólo la pestaña donde generaste el pedido conoce su código secreto. Si esa pestaña sigue abierta, volvé a ella y abrí de nuevo el enlace (o escaneá otra vez el QR) de la app Recovery. Si la cerraste, generá un pedido nuevo.';

/** Un pedido nuevo obliga a crear otra R (Recovery siempre genera una R nueva): los backups de la anterior no sirven. */
export const NEW_REQUEST_TEXT =
  'Escaneá el QR nuevo: Recovery va a crear otra clave R; destruí los backups de la anterior.';

/** Antes de pedir otro: lo mismo, dicho como consecuencia de generar el pedido nuevo. */
export const BEFORE_NEW_REQUEST_TEXT =
  'Si generás un pedido nuevo, vas a escanear un QR nuevo y Recovery va a crear otra clave R: destruí los backups de la anterior.';

/** Cuándo vence el pedido (el plazo lo fija el backend: 15 minutos mientras Recovery no informa la dirección). */
export function requestExpiryText(expiresAt: string, timeZone?: string): string {
  const time = new Date(expiresAt).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return `Este pedido vence a las ${time}: si Recovery no informa la dirección antes, vas a tener que generar otro.`;
}

/** Dejar el pedido después de una comparación que no coincidió es abortarlo (ADR-033): se informa igual. */
export const LEFT_AFTER_MISMATCH_TEXT =
  'Dejaste este pedido después de una comparación que no coincidió: se canceló y se le avisó a la plataforma. Si la dirección que copiaste de Recovery era la correcta, alguien pudo haberla cambiado en el camino.';
