// P19.T04 con la comparación reforzada de U′ ([F-LNK-04], ESC-41; tercera revisión independiente): la U′ del borrador
// se acepta sólo si coincide con la que el usuario copia de la app Wallet —10 grupos sin distinguir mayúsculas, con el
// 0x fijo y un 0x tipeado ignorado—; si no coincide se dicen qué grupos fallaron (nunca qué se esperaba) y, con casi
// ninguno, que no parece un error de tipeo; a los 3 intentos ese borrador (rotación y U′) queda bloqueado en la
// pestaña, y otra U′ registrada por la Wallet es otra comparación. Pegar la dirección completa la reparte en los grupos.
// El borrador que la plataforma canceló (REJECTED) se muestra bloqueado al volver, y esta app no firma hacia su U′.
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Rotation } from '../api/recovery-api.ts';
import { addressGroups } from '../ui/AddressText.tsx';
import {
  ADDRESS_GROUPS,
  attemptsLeft,
  BLOCKED_TEXT,
  cleanGroup,
  COMPARE_ATTEMPTS,
  compareNewKey,
  currentDraft,
  emptyGroups,
  groupsText,
  MISMATCH_TEXT,
  mismatchedGroups,
  pasteIntoGroups,
  REFUSED_PROPOSAL_TEXT,
  refusedTarget,
  rejectedText,
  REPORT_CHANGED_TEXT,
  REPORT_FAILED_TEXT,
  REPORT_UNCONFIRMED_TEXT,
  REPORTED_TEXT,
  REPORTING_TEXT,
  REREAD_ERROR_TEXT,
  retryText,
  sameDraft,
  STILL_BLOCKED_TEXT,
  type UserKeyDraft,
} from './compare.ts';

const U_NEW: Address = getAddress('0x5a3c9b11e0f4d2a7c8b6e5f4a3b2c1d0e9f8a7b6');
const U_OTHER: Address = getAddress('0x0123456789abcdef0123456789abcdef01234567');
let next = 0;
/** Cada test con su propio borrador: los intentos se recuerdan por borrador en la memoria de la pestaña. */
const draft = (newKey: Address = U_NEW): UserKeyDraft => ({ id: `rot-${String(++next)}`, newKey });
const groups = (address: Address) => addressGroups(address);

describe('comparación de U′ con la que muestra la Wallet', () => {
  it('coincide con los 10 grupos copiados, sin distinguir mayúsculas y con o sin un 0x tipeado', () => {
    const d = draft();
    expect(compareNewKey(d, groups(U_NEW))).toEqual({ match: true, newKey: U_NEW });
    expect(
      compareNewKey(
        d,
        groups(U_NEW).map((g) => g.toUpperCase()),
      ),
    ).toMatchObject({ match: true });
    const typed = groups(U_NEW).map((g) => g.toLowerCase());
    typed[0] = `0x${typed[0] ?? ''}`;
    typed[3] = ` ${typed[3] ?? ''} `;
    expect(compareNewKey(d, typed)).toEqual({ match: true, newKey: U_NEW });
    expect(attemptsLeft(d)).toBe(COMPARE_ATTEMPTS);
  });

  it('si no coincide dice qué grupos fallaron (un grupo vacío también), nunca lo esperado', () => {
    const d = draft();
    const typed = groups(U_NEW);
    typed[5] = 'ffff';
    typed[8] = '';
    const attempt = compareNewKey(d, typed);
    expect(attempt).toEqual({ match: false, mismatchedGroups: [5, 8], attemptsLeft: COMPARE_ATTEMPTS - 1 });
    const help = retryText([5, 8], 2);
    expect(help).toBe(
      'Si te equivocaste al copiar, revisá los grupos 6 y 9, y volvé a confirmar (te quedan 2 intentos).',
    );
    for (const text of [help, MISMATCH_TEXT, retryText([5], 1)]) {
      for (const group of groups(U_NEW)) expect(text.toLowerCase()).not.toContain(group.toLowerCase());
    }
    expect(retryText([5], 1)).toBe(
      'Si te equivocaste al copiar, revisá el grupo 6 y volvé a confirmar (te queda 1 intento).',
    );
  });

  it('con casi ningún grupo igual no parece un error de tipeo: no firmes y empezá de nuevo desde la Wallet', () => {
    const none = Array.from({ length: ADDRESS_GROUPS }, (_, i) => i);
    expect(retryText(none, 2)).toBe(
      'No coincide ningún grupo: no parece un error de tipeo. No firmes esta propuesta: empezá de nuevo desde la app ' +
        'Wallet («Perdí mi Password U») y avisá a soporte.',
    );
    expect(retryText(none.slice(1), 2)).toMatch(/^Coincide sólo 1 grupo de 10: no parece un error de tipeo\./);
    expect(retryText(none.slice(2), 2)).toMatch(/^Coinciden sólo 2 grupos de 10: no parece un error de tipeo\./);
    expect(retryText(none.slice(3), 2)).toMatch(/^Si te equivocaste al copiar/);
    // La U″ de un backend comprometido frente a la U′ que muestra la Wallet: no coincide casi nada.
    const attempt = compareNewKey(draft(U_OTHER), groups(U_NEW));
    expect(attempt.match).toBe(false);
    if (!attempt.match) expect(retryText(attempt.mismatchedGroups, attempt.attemptsLeft)).toMatch(/no firmes/i);
  });

  it('a los 3 intentos ese borrador queda bloqueado en la pestaña; otra U′ de la Wallet es otra comparación', () => {
    const d = draft(U_OTHER);
    const typed = groups(U_NEW);
    expect(compareNewKey(d, typed)).toMatchObject({ match: false, attemptsLeft: 2 });
    expect(compareNewKey(d, typed)).toMatchObject({ match: false, attemptsLeft: 1 });
    expect(compareNewKey(d, typed)).toMatchObject({ match: false, attemptsLeft: 0 });
    expect(attemptsLeft(d)).toBe(0);
    // Bloqueado: ni la dirección correcta del borrador se acepta (y no se cuentan más intentos).
    expect(compareNewKey(d, groups(U_OTHER))).toEqual({ match: false, mismatchedGroups: [], attemptsLeft: 0 });
    expect(attemptsLeft({ ...d, newKey: d.newKey.toLowerCase() as Address })).toBe(0);
    // La Wallet registró otra U′ en la misma rotación: se compara de nuevo, con sus 3 intentos.
    const restarted = { id: d.id, newKey: U_NEW };
    expect(sameDraft(d, restarted)).toBe(false);
    expect(attemptsLeft(restarted)).toBe(COMPARE_ATTEMPTS);
    expect(compareNewKey(restarted, typed)).toEqual({ match: true, newKey: U_NEW });
    expect(BLOCKED_TEXT).toMatch(/en 3 intentos/);
    expect(BLOCKED_TEXT).toMatch(/alguien pudo haberla cambiado en el camino/);
    expect(BLOCKED_TEXT).toMatch(/empezá de nuevo desde la app Wallet \(«Perdí mi Password U»\) y avisá a soporte\.$/);
    expect(REREAD_ERROR_TEXT).not.toMatch(/0x/);
  });

  it('una dirección inválida del backend no coincide con nada', () => {
    const invalid = 'no-es-una-direccion' as Address;
    expect(mismatchedGroups(invalid, groups(U_NEW))).toHaveLength(ADDRESS_GROUPS);
    expect(compareNewKey(draft(invalid), groups(U_NEW))).toMatchObject({ match: false });
  });

  it('el mismo borrador: misma rotación y misma U′ (sin distinguir mayúsculas)', () => {
    expect(sameDraft({ id: 'r', newKey: U_NEW }, { id: 'r', newKey: U_NEW.toLowerCase() as Address })).toBe(true);
    expect(sameDraft({ id: 'r', newKey: U_NEW }, { id: 'otra', newKey: U_NEW })).toBe(false);
  });

  it('«el grupo 6» o «los grupos 2, 5 y 9»', () => {
    expect(groupsText([5])).toBe('el grupo 6');
    expect(groupsText([1, 4, 8])).toBe('los grupos 2, 5 y 9');
  });
});

describe('lo que se tipea o se pega en los grupos', () => {
  it('un 0x tipeado y los espacios se ignoran', () => {
    expect(cleanGroup('0x')).toBe('');
    expect(cleanGroup('0X5a')).toBe('5a');
    expect(cleanGroup(' 5a 3c ')).toBe('5a3c');
    expect(emptyGroups()).toEqual(Array.from({ length: ADDRESS_GROUPS }, () => ''));
  });

  it('la dirección completa (con 0x y espacios, como la muestra la Wallet) llena los 10 grupos desde el primero', () => {
    const shown = `0x ${groups(U_NEW).join(' ')}`;
    expect(pasteIntoGroups(emptyGroups(), 4, shown)).toEqual(groups(U_NEW));
    expect(pasteIntoGroups(emptyGroups(), 0, U_NEW.toLowerCase())).toEqual(U_NEW.toLowerCase().slice(2).match(/.{4}/g));
  });

  it('un pedazo más largo que un grupo sigue en los siguientes desde el cursor; uno que entra se pega como siempre', () => {
    const current = emptyGroups();
    current[2] = '12';
    expect(pasteIntoGroups(current, 2, '345678', { start: 2, end: 2 })).toEqual([
      '',
      '',
      '1234',
      '5678',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    // Entra en el campo sin espacios ni 0x: lo pega el navegador.
    expect(pasteIntoGroups(current, 2, '34', { start: 2, end: 2 })).toBeNull();
    // Con un 0x adelante, aunque entre: la app lo saca y lo pone en el grupo.
    expect(pasteIntoGroups(emptyGroups(), 0, '0x5a3c')).toEqual(['5a3c', '', '', '', '', '', '', '', '', '']);
    // Sólo espacios: el grupo queda vacío.
    expect(pasteIntoGroups(emptyGroups(), 1, '   ')).toEqual(emptyGroups());
  });
});

/** Una rotación de U como la lista el backend (de la más nueva a la más vieja), ya validada. */
const rotation = (overrides: Partial<Rotation>): Rotation => ({
  id: `rot-list-${String(++next)}`,
  walletId: 'w1',
  role: 'U',
  oldKey: getAddress('0x000000000000000000000000000000000000dEaD'),
  newKey: U_NEW,
  status: 'DRAFT',
  origin: 'PLATFORM',
  initiatedBy: 'R',
  proposalId: null,
  executableAt: null,
  cancelledBy: null,
  proposeOperationId: null,
  executeOperationId: null,
  proposedAt: null,
  executedAt: null,
  failureReason: null,
  createdAt: '2026-10-25T10:00:00Z',
  cancelTypedData: null,
  requestReason: null,
  newKeyAttestation: null,
  rejectionReason: null,
  ...overrides,
});

describe('el borrador que muestra la pantalla y el rechazo de la plataforma', () => {
  it('el borrador vigente; si no hay, el último pedido si la plataforma lo canceló y no hubo otra rotación de U', () => {
    const draft = rotation({});
    const rejected = rotation({ status: 'REJECTED', newKey: U_OTHER, rejectionReason: 'MANUAL_COMPARISON_FAILED' });
    // Un registro nuevo en la Wallet después del rechazo es otro borrador: se compara de nuevo.
    expect(currentDraft([draft, rejected])).toEqual({ draft: { id: draft.id, newKey: U_NEW }, rejection: null });
    expect(currentDraft([rejected])).toEqual({
      draft: { id: rejected.id, newKey: U_OTHER },
      rejection: { reason: 'MANUAL_COMPARISON_FAILED' },
    });
    // Un motivo que esta versión no conoce, o un backend anterior que no lo manda: igual bloqueado.
    expect(currentDraft([{ ...rejected, rejectionReason: 'UNKNOWN' }])?.rejection).toEqual({ reason: 'UNKNOWN' });
    expect(currentDraft([{ ...rejected, rejectionReason: null }])?.rejection).toEqual({ reason: null });
    // Después del rechazo hubo otra rotación de U (ya ejecutada): no hay pedido que mostrar.
    expect(currentDraft([rotation({ status: 'EXECUTED', initiatedBy: 'R' }), rejected])).toBeNull();
    // Otras rotaciones (de S, o de U propuestas por U) no son el pedido de la Wallet; sin rotaciones, tampoco.
    expect(currentDraft([rotation({ role: 'S' })])).toBeNull();
    expect(currentDraft([rotation({ initiatedBy: 'U' })])).toBeNull();
    expect(currentDraft([rotation({ status: 'REJECTED', initiatedBy: 'U' })])).toBeNull();
    expect(currentDraft(null)).toBeNull();
    expect(currentDraft([])).toBeNull();
  });

  it('esta app no firma hacia la U′ de un borrador cancelado ni de uno bloqueado en la pestaña', () => {
    const swapped = getAddress('0x9999999999999999999999999999999999999999');
    const rejected = rotation({ status: 'REJECTED', newKey: swapped, rejectionReason: 'MANUAL_COMPARISON_FAILED' });
    expect(refusedTarget(swapped, [rejected])).toBe(true);
    expect(refusedTarget(swapped.toLowerCase() as Address, [rejected])).toBe(true);
    expect(refusedTarget(U_NEW, [rejected])).toBe(false);
    expect(refusedTarget(swapped, [rotation({ newKey: swapped })])).toBe(false);
    expect(refusedTarget(swapped, [rotation({ role: 'S', status: 'REJECTED', newKey: swapped })])).toBe(false);
    expect(refusedTarget('no-es-una-direccion' as Address, [rejected])).toBe(false);
    // Bloqueado en la pestaña (aunque el aviso no haya llegado): tampoco.
    const blocked = getAddress('0x8888888888888888888888888888888888888888');
    const d = draft(blocked);
    expect(refusedTarget(blocked, null)).toBe(false);
    for (let i = 0; i < COMPARE_ATTEMPTS; i++) compareNewKey(d, groups(U_NEW));
    expect(refusedTarget(blocked, null)).toBe(true);
    expect(REFUSED_PROPOSAL_TEXT).toContain('esta app no la va a ejecutar');
    expect(REFUSED_PROPOSAL_TEXT).toContain('Cancelala con tu clave R desde «Rotaciones» y avisá a soporte.');
  });

  it('los textos del bloqueo dicen que esta app no firma, que alguien pudo cambiarla y qué hacer, sin datos del backend', () => {
    const rejected = rejectedText('MANUAL_COMPARISON_FAILED');
    expect(rejected).toMatch(/^Este pedido quedó cancelado porque la dirección de la clave U nueva no coincidió/);
    expect(rejected).toContain('esta app no va a firmar el reemplazo de tu clave U hacia esa dirección');
    expect(rejected).toContain('Si la copiaste bien de la app Wallet, alguien pudo haberla cambiado en el camino.');
    expect(rejected).toMatch(/empezá de nuevo desde la app Wallet \(«Perdí mi Password U»\) y avisá a soporte\.$/);
    // Un motivo desconocido: el mismo bloqueo, sin el código.
    expect(rejectedText('UNKNOWN')).toMatch(/^Este pedido de reemplazo de tu clave U quedó cancelado: esta app no va/);
    expect(rejectedText(null)).toBe(rejectedText('UNKNOWN'));
    for (const text of [
      rejected,
      rejectedText('UNKNOWN'),
      REPORTING_TEXT,
      REPORTED_TEXT,
      REPORT_FAILED_TEXT,
      REPORT_UNCONFIRMED_TEXT,
      REPORT_CHANGED_TEXT,
      STILL_BLOCKED_TEXT,
    ]) {
      expect(text).not.toMatch(/0x|UNKNOWN|MANUAL_COMPARISON_FAILED/);
    }
    expect(STILL_BLOCKED_TEXT).toContain('Esta app igual no va a firmar hacia esa dirección');
    expect(REPORT_FAILED_TEXT).toBe('No se pudo avisar a la plataforma.');
    // La pantalla relee las rotaciones sola: recargar descartaría R y la verificación (N10).
    expect(REPORT_CHANGED_TEXT).toBe(
      'La plataforma informa que este pedido cambió (la app Wallet pudo registrar otra clave U nueva): la pantalla se actualiza sola.',
    );
    expect(REPORT_CHANGED_TEXT).not.toMatch(/recarg|volvé a cargar/);
  });
});
