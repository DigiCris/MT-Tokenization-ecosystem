// Activar Recovery (P18.T01, [F-LNK-01/02]): la Wallet pide un enrollment, se lo pasa a la app Recovery por un link
// cuyo fragmento (que no llega a ningún servidor) lleva el id y el nonce —también como QR—, espera a que Recovery
// envíe R y confirma esa R: con el fragmento del link de regreso (`r` tiene que ser exactamente la R que informa el
// backend; si difieren se aborta) o, si el usuario usó otro dispositivo sin link, con una comparación manual de la
// dirección completa (los 10 grupos de 4 caracteres, copiados de la pantalla de Recovery) antes de que U firme nada.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { CreatedEnrollment, RecoveryEnrollment } from '../api/wallet-api.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RecoveryActivationError extends Error {
  override name = 'RecoveryActivationError';
}

/** La R del link de regreso no es la que informa la plataforma: la activación se aborta y se pide otro enrollment. */
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

/** [F-LNK-02]: fragmento del link de regreso `…/onboarding/confirm-recovery#eid=<id>&r=<R>`. */
export function parseRecoveryReturn(fragment: string): { enrollmentId: string; recoveryKey: Address } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const eid = params.get('eid');
  const r = params.get('r');
  if (eid === null || r === null || !UUID.test(eid) || !isAddress(r)) return null;
  return { enrollmentId: eid.toLowerCase(), recoveryKey: getAddress(r) };
}

/** R que envió Recovery para este enrollment (o null mientras no llegó); falla si el enrollment ya no sirve. */
export function submittedRecoveryKey(enrollment: RecoveryEnrollment): Address | null {
  if (enrollment.status === 'EXPIRED' || enrollment.status === 'REJECTED' || enrollment.status === 'RETIRED') {
    throw new RecoveryActivationError('El pedido a Recovery venció o fue reemplazado: generá uno nuevo.');
  }
  if (enrollment.status === 'REQUESTED' || enrollment.recoveryKey === null) return null;
  return getAddress(enrollment.recoveryKey);
}

/** Con link de regreso: la R del fragmento tiene que ser exactamente la del backend, para ese mismo enrollment. */
export function confirmWithReturnLink(
  enrollment: RecoveryEnrollment,
  fromLink: { enrollmentId: string; recoveryKey: Address },
): Address {
  const reported = submittedRecoveryKey(enrollment);
  if (reported === null) throw new RecoveryActivationError('Recovery todavía no envió la clave.');
  if (fromLink.enrollmentId !== enrollment.id.toLowerCase()) {
    throw new RecoveryActivationError('El link de regreso es de otro pedido de Recovery.');
  }
  if (!isAddressEqual(fromLink.recoveryKey, reported)) {
    throw new RecoveryKeyMismatchError(
      'La clave que muestra Recovery no es la que informa la plataforma: se cancela la activación.',
    );
  }
  return reported;
}

/** Dirección en grupos de 4 caracteres hexadecimales (sin el 0x), como la muestran las dos apps. */
export function addressGroups(address: Address): string[] {
  return getAddress(address).slice(2).match(/.{4}/g) ?? [];
}

/**
 * Sin link: la dirección completa copiada de Recovery —los 10 grupos, sin distinguir mayúsculas— tiene que coincidir con
 * la R del backend.
 */
export function confirmManually(enrollment: RecoveryEnrollment, typed: readonly string[]): Address {
  const reported = submittedRecoveryKey(enrollment);
  if (reported === null) throw new RecoveryActivationError('Recovery todavía no envió la clave.');
  const groups = addressGroups(reported);
  const complete =
    typed.length === groups.length &&
    groups.every((group, i) => (typed[i] ?? '').trim().toLowerCase() === group.toLowerCase());
  if (!complete) {
    throw new RecoveryActivationError(
      'Los caracteres no coinciden con la clave que informa la plataforma: revisá la pantalla de Recovery.',
    );
  }
  return reported;
}
