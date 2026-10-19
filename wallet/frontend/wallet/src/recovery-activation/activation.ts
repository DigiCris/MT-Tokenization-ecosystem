// Activar Recovery (P18.T01, [F-LNK-01/02]): la Wallet pide un enrollment, se lo pasa a la app Recovery por un enlace
// cuyo fragmento (que no llega a ningún servidor) lleva el id y el nonce —también como QR—, espera a que Recovery
// informe la dirección de R y la confirma: con el fragmento del enlace de regreso (`r` tiene que ser exactamente la R
// que informa el backend; si difieren se aborta) o, si el usuario usó otro dispositivo sin enlace, con una comparación
// manual de la dirección completa (los 10 grupos de 4 caracteres, copiados de la pantalla de Recovery) antes de que U
// firme nada. La Wallet no muestra la R del backend hasta que coincide, así que no se la puede copiar de su propia
// pantalla; la comparación manual tiene 3 intentos por pedido y, al agotarse, el pedido se aborta como con un enlace de
// regreso distinto.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Grupos de 4 caracteres de una dirección (sus 40 caracteres hexadecimales, sin el 0x). */
export const ADDRESS_GROUPS = 10;
/** Intentos de la comparación manual por pedido. */
export const MANUAL_ATTEMPTS = 3;

export class RecoveryActivationError extends Error {
  override name = 'RecoveryActivationError';
}

/** La R del enlace de regreso no es la que informa la plataforma: la activación se aborta y se pide otro enrollment. */
export class RecoveryKeyMismatchError extends RecoveryActivationError {
  override name = 'RecoveryKeyMismatchError';
}

/** [F-LNK-01]: `https://recovery…/enroll#eid=<enrollmentId>&n=<nonce>`. */
export function recoveryEnrollLink(
  recoveryOrigin: string,
  enrollment: Pick<CreatedEnrollment, 'enrollmentId' | 'nonce'>,
) {
  const url = new URL('/enroll', recoveryOrigin);
  url.hash = new URLSearchParams({ eid: enrollment.enrollmentId, n: enrollment.nonce }).toString();
  return url.toString();
}

/** [F-LNK-02]: fragmento del enlace de regreso `…/onboarding/confirm-recovery#eid=<id>&r=<R>`. */
export function parseRecoveryReturn(fragment: string): { enrollmentId: string; recoveryKey: Address } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const eid = params.get('eid');
  const r = params.get('r');
  if (eid === null || r === null || !UUID.test(eid) || !isAddress(r)) return null;
  return { enrollmentId: eid.toLowerCase(), recoveryKey: getAddress(r) };
}

/** R que informó Recovery para este enrollment (o null mientras no llegó); falla si el enrollment ya no sirve. */
export function submittedRecoveryKey(enrollment: RecoveryEnrollment): Address | null {
  if (enrollment.status === 'EXPIRED' || enrollment.status === 'REJECTED' || enrollment.status === 'RETIRED') {
    throw new RecoveryActivationError('El pedido a Recovery venció o fue reemplazado: generá uno nuevo.');
  }
  if (enrollment.status === 'REQUESTED' || enrollment.recoveryKey === null) return null;
  return getAddress(enrollment.recoveryKey);
}

/** Con enlace de regreso: la R del fragmento tiene que ser exactamente la del backend, para ese mismo enrollment. */
export function confirmWithReturnLink(
  enrollment: RecoveryEnrollment,
  fromLink: { enrollmentId: string; recoveryKey: Address },
): Address {
  const reported = submittedRecoveryKey(enrollment);
  if (reported === null) throw new RecoveryActivationError('Recovery todavía no informó la dirección de tu clave R.');
  if (fromLink.enrollmentId !== enrollment.id.toLowerCase()) {
    throw new RecoveryActivationError('El enlace de regreso es de otro pedido de Recovery.');
  }
  if (!isAddressEqual(fromLink.recoveryKey, reported)) {
    throw new RecoveryKeyMismatchError(
      'La dirección que trae el enlace de Recovery no es la que recibió la plataforma: alguien pudo haberla cambiado en el camino. Se canceló este pedido.',
    );
  }
  return reported;
}

/** Dirección en grupos de 4 caracteres hexadecimales (sin el 0x), como la muestran las dos apps. */
export function addressGroups(address: Address): string[] {
  return getAddress(address).slice(2).match(/.{4}/g) ?? [];
}

/** Un grupo tipeado en su forma comparable: sin espacios y en minúsculas (da igual cómo se haya escrito). */
function comparableGroup(value: string | undefined): string {
  return (value ?? '').replace(/\s/g, '').toLowerCase();
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

/** Qué revisar si fue un error de tipeo y cuántos intentos le quedan al pedido. */
export function manualRetryText(mismatchedGroups: readonly number[], attemptsLeft: number): string {
  const left = attemptsLeft === 1 ? 'te queda 1 intento' : `te quedan ${String(attemptsLeft)} intentos`;
  return `Si te equivocaste al copiar, revisá ${groupsText(mismatchedGroups)} y volvé a confirmar (${left}).`;
}

/** Se agotaron los intentos de la comparación manual: el pedido se aborta. */
export const MANUAL_ABORT_TEXT = `La dirección no coincidió con la que recibió la plataforma en ${String(MANUAL_ATTEMPTS)} intentos: se canceló este pedido. Si la copiaste bien de Recovery, alguien pudo haberla cambiado en el camino.`;
