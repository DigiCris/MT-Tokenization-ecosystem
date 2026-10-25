// Comparación de U′ antes de que R firme la propuesta del reemplazo de U (P19.T04, [F-LNK-04], ESC-41). El borrador
// que deja la app Wallet con «Perdí mi Password U» trae U′ desde el backend: un backend comprometido podría cambiarla
// por una U″ suya para que R proponga el reemplazo hacia ella. Por eso Recovery no muestra la U′ del backend hasta que
// coincide con la dirección que el usuario copia de la app Wallet —que generó U′ en su dispositivo—: los 10 grupos de
// 4 caracteres (el 0x ya está puesto), sin distinguir mayúsculas, con 3 intentos por borrador (por rotación y U′; si
// la Wallet registra otra U′, es otra comparación). Si no coincide, sólo se dice qué grupos fallaron, nunca qué se
// esperaba. Al agotar los intentos, esta app ya no firma la propuesta hacia esa U′ y le avisa a la plataforma, que
// cancela el borrador (REJECTED, con auditoría, aviso, email y alerta) y ya no lo propone: al recargar, el borrador
// rechazado aparece bloqueado. Si el aviso no llega (sin red), el bloqueo de la pestaña sigue y el aviso se reintenta.
// Es el mismo criterio con el que la Wallet confirma R ([F-LNK-02]), implementado por separado: Recovery no comparte
// código con Wallet.
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { Rotation, UReplacementRejectionReason, UnknownCode } from '../api/recovery-api.ts';
import { addressGroups } from '../ui/AddressText.tsx';

/** Grupos de 4 caracteres de una dirección (sus 40 caracteres hexadecimales, sin el 0x). */
export const ADDRESS_GROUPS = 10;
/** Intentos de la comparación por borrador. */
export const COMPARE_ATTEMPTS = 3;
/** Con a lo sumo estos grupos coincidentes, no parece un error de tipeo. */
const NEARLY_NONE = 2;

/** El borrador de la rotación de U que dejó la Wallet: la rotación y la U′ que informa el backend. */
export interface UserKeyDraft {
  id: string;
  newKey: Address;
}

/** El pedido de la pantalla: el borrador y, si la plataforma ya lo canceló (REJECTED), por qué. */
export interface CurrentDraft {
  draft: UserKeyDraft;
  rejection: { reason: UReplacementRejectionReason | UnknownCode | null } | null;
}

/**
 * El pedido del reemplazo de U que dejó la Wallet con «Perdí mi Password U» (lo propone R): el borrador vigente o, si
 * no hay, el último pedido si esta app lo rechazó y no hubo otra rotación de U después (las rotaciones llegan de la más
 * nueva a la más vieja). Un registro nuevo en la Wallet es otro borrador, que se compara de nuevo.
 */
export function currentDraft(rotations: readonly Rotation[] | null): CurrentDraft | null {
  const own = (rotations ?? []).filter((r) => r.role === 'U');
  const draft = own.find((r) => r.status === 'DRAFT' && r.initiatedBy === 'R');
  if (draft) return { draft: { id: draft.id, newKey: draft.newKey }, rejection: null };
  const latest = own[0];
  if (latest?.status !== 'REJECTED' || latest.initiatedBy !== 'R') return null;
  return { draft: { id: latest.id, newKey: latest.newKey }, rejection: { reason: latest.rejectionReason } };
}

export const emptyGroups = (): string[] => Array.from({ length: ADDRESS_GROUPS }, () => '');

/** Lo tipeado en un grupo, sin espacios ni un 0x adelante (el 0x ya está fijo antes del grupo 1). */
export function cleanGroup(value: string): string {
  return value.replace(/\s/g, '').replace(/^0x/i, '');
}

/**
 * Lo que queda en los grupos al pegar `pasted` en el grupo `index`, con su selección: la dirección completa (con o sin
 * 0x y espacios, como la muestra la Wallet) llena los 10 desde el primero; otro texto, sin espacios ni 0x, se inserta
 * donde está el cursor y lo que no entra en el grupo sigue en los siguientes. null si el navegador puede pegarlo tal
 * cual (entra en el campo y no trae espacios ni 0x).
 */
export function pasteIntoGroups(
  current: readonly string[],
  index: number,
  pasted: string,
  selection: { start: number; end: number } = { start: 0, end: (current[index] ?? '').length },
): string[] | null {
  const compact = cleanGroup(pasted);
  const field = current[index] ?? '';
  const merged = field.slice(0, selection.start) + compact + field.slice(selection.end);
  if (compact === pasted && merged.length <= 4) return null;
  if (compact.length === ADDRESS_GROUPS * 4) return compact.match(/.{4}/g) ?? [...current];
  const chunks = merged.match(/.{1,4}/g) ?? [''];
  return current.map((value, i) => (i >= index && i - index < chunks.length ? (chunks[i - index] ?? '') : value));
}

/**
 * Los grupos que no coinciden con la dirección (posiciones desde 0): un grupo vacío cuenta como distinto, y si el
 * backend no informa una dirección válida no coincide ninguno.
 */
export function mismatchedGroups(expected: Address, typed: readonly string[]): number[] {
  if (!isAddress(expected, { strict: false })) return Array.from({ length: ADDRESS_GROUPS }, (_, i) => i);
  return addressGroups(expected).flatMap((group, i) =>
    cleanGroup(typed[i] ?? '').toLowerCase() === group.toLowerCase() ? [] : [i],
  );
}

// Intentos fallidos por borrador, en la memoria de esta pestaña (sobreviven a salir de la pantalla y volver).
const failures = new Map<string, number>();
/** Un borrador por su rotación y su U′ (si la Wallet registra otra U′ en la misma rotación, es otro). */
export const draftKey = (draft: UserKeyDraft) => `${draft.id}:${draft.newKey.toLowerCase()}`;

/** El mismo borrador: la misma rotación con la misma U′ (si la Wallet registra otra U′, es otro). */
export function sameDraft(a: UserKeyDraft, b: UserKeyDraft): boolean {
  return draftKey(a) === draftKey(b);
}

/** Cuántos intentos le quedan a ese borrador (0: esta pestaña ya no firma la propuesta hacia esa U′). */
export function attemptsLeft(draft: UserKeyDraft): number {
  return Math.max(0, COMPARE_ATTEMPTS - (failures.get(draftKey(draft)) ?? 0));
}

/**
 * Una dirección hacia la que esta app no firma el reemplazo de U: la U′ de un borrador que la plataforma canceló por
 * no coincidir, o la de uno que agotó los intentos en esta pestaña (aunque el aviso no haya llegado). Así tampoco se
 * ejecuta una propuesta hacia ella que haya aparecido en el timelock.
 */
export function refusedTarget(address: Address, rotations: readonly Rotation[] | null): boolean {
  if (!isAddress(address, { strict: false })) return false;
  const same = (other: string) => isAddress(other, { strict: false }) && isAddressEqual(other, address);
  const rejected = (rotations ?? []).some((r) => r.role === 'U' && r.status === 'REJECTED' && same(r.newKey));
  const blocked = [...failures].some(
    ([key, count]) => count >= COMPARE_ATTEMPTS && same(key.slice(key.lastIndexOf(':') + 1)),
  );
  return rejected || blocked;
}

/**
 * Un intento de la comparación contra el borrador vigente: la U′ confirmada o, si no coincide, qué grupos fallaron y
 * cuántos intentos le quedan. Nunca dice qué caracteres se esperaban. Con los intentos agotados no compara.
 */
export type CompareAttempt =
  { match: true; newKey: Address } | { match: false; mismatchedGroups: number[]; attemptsLeft: number };

export function compareNewKey(draft: UserKeyDraft, typed: readonly string[]): CompareAttempt {
  if (attemptsLeft(draft) === 0) return { match: false, mismatchedGroups: [], attemptsLeft: 0 };
  const mismatched = mismatchedGroups(draft.newKey, typed);
  if (mismatched.length === 0) return { match: true, newKey: getAddress(draft.newKey) };
  failures.set(draftKey(draft), (failures.get(draftKey(draft)) ?? 0) + 1);
  return { match: false, mismatchedGroups: mismatched, attemptsLeft: attemptsLeft(draft) };
}

/** «el grupo 6» o «los grupos 2, 5 y 9» (las posiciones van desde 0 y se muestran desde 1). */
export function groupsText(positions: readonly number[]): string {
  const shown = positions.map((p) => String(p + 1));
  if (shown.length <= 1) return `el grupo ${shown[0] ?? ''}`;
  return `los grupos ${shown.slice(0, -1).join(', ')} y ${shown.at(-1) ?? ''}`;
}

/** Qué hacer si no se puede seguir con este borrador (lo repiten el aviso de casi ningún grupo y el bloqueo). */
const START_OVER = 'empezá de nuevo desde la app Wallet («Perdí mi Password U») y avisá a soporte.';

/** La comparación no coincide: puede ser un error de tipeo o una U′ cambiada en el camino. */
export const MISMATCH_TEXT =
  'No coincide con la dirección que recibió la plataforma. Si la copiaste bien de la app Wallet, no firmes: alguien pudo haberla cambiado.';

/**
 * Qué revisar si fue un error de tipeo y cuántos intentos quedan; si no coincide ningún grupo (o casi ninguno), no
 * parece un error de tipeo y se recomienda no firmar.
 */
export function retryText(mismatched: readonly number[], left: number): string {
  const matching = ADDRESS_GROUPS - mismatched.length;
  if (matching <= NEARLY_NONE) {
    const which =
      matching === 0
        ? 'No coincide ningún grupo'
        : `Coincide${matching === 1 ? ' sólo 1 grupo' : `n sólo ${String(matching)} grupos`} de ${String(ADDRESS_GROUPS)}`;
    return `${which}: no parece un error de tipeo. No firmes esta propuesta: ${START_OVER}`;
  }
  const remaining = left === 1 ? 'te queda 1 intento' : `te quedan ${String(left)} intentos`;
  const separator = mismatched.length > 1 ? ',' : '';
  return `Si te equivocaste al copiar, revisá ${groupsText(mismatched)}${separator} y volvé a confirmar (${remaining}).`;
}

/** Se agotaron los intentos: esta app ya no firma la propuesta hacia esa U′. */
export const BLOCKED_TEXT = `La dirección no coincidió con la que recibió la plataforma en ${String(COMPARE_ATTEMPTS)} intentos: esta app no va a firmar el reemplazo de tu clave U hacia esa dirección. Si la copiaste bien de la app Wallet, alguien pudo haberla cambiado en el camino. No sigas con este pedido: ${START_OVER}`;

/**
 * Un borrador que la plataforma ya canceló (al cargar la pantalla): esta app no firma hacia esa U′. Con un motivo que
 * esta versión no conoce, el mismo bloqueo sin decir por qué (nunca el código del backend).
 */
export function rejectedText(reason: UReplacementRejectionReason | UnknownCode | null): string {
  const why =
    reason === 'MANUAL_COMPARISON_FAILED'
      ? 'Este pedido quedó cancelado porque la dirección de la clave U nueva no coincidió con la que recibió la plataforma'
      : 'Este pedido de reemplazo de tu clave U quedó cancelado';
  return `${why}: esta app no va a firmar el reemplazo de tu clave U hacia esa dirección. Si la copiaste bien de la app Wallet, alguien pudo haberla cambiado en el camino. No sigas con este pedido: ${START_OVER}`;
}

/** El aviso a la plataforma de que el borrador no coincidió: en curso, registrado o sin confirmar. */
export const REPORTING_TEXT = 'Avisando a la plataforma para que cancele este pedido…';
export const REPORTED_TEXT = 'La plataforma registró que este pedido quedó cancelado: tampoco lo va a proponer.';
export const REPORT_FAILED_TEXT = 'No se pudo avisar a la plataforma.';
/** Con el aviso sin llegar, el bloqueo de esta app sigue. */
export const STILL_BLOCKED_TEXT =
  'Esta app igual no va a firmar hacia esa dirección: reintentá el aviso para que la plataforma cancele el pedido.';
/** La plataforma aceptó el aviso pero no muestra el pedido como cancelado. */
export const REPORT_UNCONFIRMED_TEXT =
  'La plataforma no muestra este pedido como cancelado. Esta app igual no va a firmar hacia esa dirección: reintentá el aviso.';
/** La plataforma respondió que el pedido cambió (la Wallet registró otra U′ en él, o ya no es un borrador). */
export const REPORT_CHANGED_TEXT =
  'La plataforma informa que este pedido cambió (la app Wallet pudo registrar otra clave U nueva): volvé a cargar esta pantalla.';

/** La relectura del borrador antes de aceptar la comparación falló por la red (no cuenta como intento). */
export const REREAD_ERROR_TEXT =
  'No se pudo consultar el pedido a la plataforma: revisá tu conexión y volvé a confirmar.';

/** Una propuesta en el timelock hacia una U′ que no coincidió: esta app no la ejecuta. */
export const REFUSED_PROPOSAL_TEXT =
  'Esta propuesta reemplaza tu clave U por una dirección que no coincidió con la que copiaste de la app Wallet: esta app no la va a ejecutar. Cancelala con tu clave R desde «Rotaciones» y avisá a soporte.';
