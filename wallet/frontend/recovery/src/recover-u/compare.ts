// Comparación de U′ antes de que R firme la propuesta del reemplazo de U (P19.T04, [F-LNK-04], ESC-41). El borrador
// que deja la app Wallet con «Perdí mi Password U» trae U′ desde el backend: un backend comprometido podría cambiarla
// por una U″ suya para que R proponga el reemplazo hacia ella. Por eso Recovery no muestra la U′ del backend hasta que
// coincide con la dirección que el usuario copia de la app Wallet —que generó U′ en su dispositivo—: los 10 grupos de
// 4 caracteres (el 0x ya está puesto), sin distinguir mayúsculas, con 3 intentos por borrador (por rotación y U′; si
// la Wallet registra otra U′, es otra comparación). Si no coincide, sólo se dice qué grupos fallaron, nunca qué se
// esperaba. Al agotar los intentos, esta pestaña ya no firma la propuesta hacia esa U′ (la memoria es de la pestaña:
// el backend no se entera, porque no tiene una ruta para rechazar el borrador). Es el mismo criterio con el que la
// Wallet confirma R ([F-LNK-02]), implementado por separado: Recovery no comparte código con Wallet.
import { getAddress, isAddress, type Address } from 'viem';
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
const draftKey = (draft: UserKeyDraft) => `${draft.id}:${draft.newKey.toLowerCase()}`;

/** El mismo borrador: la misma rotación con la misma U′ (si la Wallet registra otra U′, es otro). */
export function sameDraft(a: UserKeyDraft, b: UserKeyDraft): boolean {
  return draftKey(a) === draftKey(b);
}

/** Cuántos intentos le quedan a ese borrador (0: esta pestaña ya no firma la propuesta hacia esa U′). */
export function attemptsLeft(draft: UserKeyDraft): number {
  return Math.max(0, COMPARE_ATTEMPTS - (failures.get(draftKey(draft)) ?? 0));
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

/** Se agotaron los intentos: esta pestaña ya no firma la propuesta hacia esa U′. */
export const BLOCKED_TEXT = `La dirección no coincidió con la que recibió la plataforma en ${String(COMPARE_ATTEMPTS)} intentos: esta app no va a firmar el reemplazo de tu clave U hacia esa dirección. Si la copiaste bien de la app Wallet, alguien pudo haberla cambiado en el camino. No sigas con este pedido: ${START_OVER}`;

/** La relectura del borrador antes de aceptar la comparación falló por la red (no cuenta como intento). */
export const REREAD_ERROR_TEXT =
  'No se pudo consultar el pedido a la plataforma: revisá tu conexión y volvé a confirmar.';
