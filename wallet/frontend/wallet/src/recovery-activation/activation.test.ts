// P18.T01 [F-LNK-01/02]: enlace a Recovery con el enrollment en el fragmento, enlace de regreso con la R, y confirmación
// de R: con el enlace tiene que ser exactamente la del backend y del mismo enrollment; sin enlace, la dirección completa
// copiada de Recovery (sus 10 grupos, sin distinguir mayúsculas) tiene que coincidir, con 3 intentos por pedido y sin
// revelar los caracteres esperados. Un enrollment vencido o reemplazado no se usa.
import { describe, expect, it } from 'vitest';
import type { RecoveryEnrollment } from '../api/wallet-api.ts';
import {
  ADDRESS_GROUPS,
  addressGroups,
  compareManually,
  confirmWithReturnLink,
  groupsText,
  MANUAL_ABORT_TEXT,
  MANUAL_ATTEMPTS,
  MANUAL_MISMATCH_TEXT,
  manualRetryText,
  parseRecoveryReturn,
  recoveryEnrollLink,
  RecoveryActivationError,
  RecoveryKeyMismatchError,
  submittedRecoveryKey,
} from './activation.ts';

const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const enrollment = (overrides: Partial<RecoveryEnrollment> = {}): RecoveryEnrollment => ({
  id: ID,
  walletId: 'w',
  purpose: 'ONBOARDING',
  status: 'SUBMITTED',
  expiresAt: '2026-10-18T12:15:00Z',
  enrollmentKeyRegistered: true,
  recoveryKey: R,
  rType: 'INTERNAL',
  submittedAt: '2026-10-18T12:05:00Z',
  confirmedAt: null,
  ...overrides,
});

describe('activar Recovery', () => {
  it('enlace de ida con id y nonce en el fragmento (no llegan a ningún servidor)', () => {
    const nonce = `0x${'ab'.repeat(32)}` as const;
    const link = recoveryEnrollLink('https://recovery.example', { enrollmentId: ID, nonce });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://recovery.example/enroll');
    expect(url.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ eid: ID, n: nonce });
  });

  it('enlace de regreso: id y R válidos o nada', () => {
    expect(parseRecoveryReturn(`#eid=${ID}&r=${R.toLowerCase()}`)).toEqual({ enrollmentId: ID, recoveryKey: R });
    expect(parseRecoveryReturn(`#eid=no-es-uuid&r=${R}`)).toBeNull();
    expect(parseRecoveryReturn(`#eid=${ID}&r=0x1234`)).toBeNull();
    expect(parseRecoveryReturn('')).toBeNull();
  });

  it('mientras Recovery no informó R no hay nada que confirmar; vencido o reemplazado falla', () => {
    expect(submittedRecoveryKey(enrollment({ status: 'REQUESTED', recoveryKey: null }))).toBeNull();
    expect(submittedRecoveryKey(enrollment())).toBe(R);
    for (const status of ['EXPIRED', 'REJECTED', 'RETIRED'] as const) {
      expect(() => submittedRecoveryKey(enrollment({ status }))).toThrow(RecoveryActivationError);
    }
  });

  it('con enlace de regreso: la R tiene que ser la del backend y del mismo pedido', () => {
    expect(confirmWithReturnLink(enrollment(), { enrollmentId: ID, recoveryKey: R })).toBe(R);
    // Otra R aborta la activación (error propio, la UI pide un enrollment nuevo); otro pedido es otro error.
    const otherKey = () =>
      confirmWithReturnLink(enrollment(), {
        enrollmentId: ID,
        recoveryKey: '0x000000000000000000000000000000000000dEaD',
      });
    expect(otherKey).toThrow(RecoveryKeyMismatchError);
    expect(otherKey).toThrow('alguien pudo haberla cambiado en el camino. Se canceló este pedido.');
    const otherRequest = () =>
      confirmWithReturnLink(enrollment(), { enrollmentId: '11111111-1111-4111-8111-111111111111', recoveryKey: R });
    expect(otherRequest).toThrow('otro pedido');
    expect(otherRequest).not.toThrow(RecoveryKeyMismatchError);
    expect(() =>
      confirmWithReturnLink(enrollment({ status: 'REQUESTED', recoveryKey: null }), {
        enrollmentId: ID,
        recoveryKey: R,
      }),
    ).toThrow('todavía no informó');
  });
});

describe('comparación manual de la dirección de R (sin enlace de regreso)', () => {
  const groups = addressGroups(R);

  it('la dirección va en 10 grupos de 4 caracteres, sin el 0x', () => {
    expect(groups).toHaveLength(ADDRESS_GROUPS);
    expect(groups.join('')).toBe(R.slice(2));
    expect(groups.every((g) => g.length === 4)).toBe(true);
  });

  it('coincide con la dirección completa, sin distinguir mayúsculas ni espacios', () => {
    expect(compareManually(enrollment(), groups, 0)).toEqual({ match: true, recoveryKey: R });
    expect(
      compareManually(
        enrollment(),
        groups.map((g) => ` ${g.toLowerCase()} `),
        0,
      ),
    ).toEqual({
      match: true,
      recoveryKey: R,
    });
    expect(
      compareManually(
        enrollment(),
        groups.map((g) => g.toUpperCase()),
        2,
      ),
    ).toEqual({ match: true, recoveryKey: R });
  });

  it('si no coincide dice qué grupos fallan (nunca qué caracteres se esperaban) y cuántos intentos quedan', () => {
    const typo = groups.map((g, i) => (i === 5 ? (g === '0000' ? '1111' : '0000') : g));
    const first = compareManually(enrollment(), typo, 0);
    expect(first).toEqual({ match: false, mismatchedGroups: [5], attemptsLeft: 2 });
    expect(JSON.stringify(first)).not.toContain(groups[5]);
    // Un grupo vacío, menos grupos o nada: los que faltan cuentan como distintos.
    expect(
      compareManually(
        enrollment(),
        groups.map((g, i) => (i === 0 ? '' : g)),
        0,
      ),
    ).toMatchObject({
      match: false,
      mismatchedGroups: [0],
    });
    expect(compareManually(enrollment(), groups.slice(0, 9), 0)).toMatchObject({ match: false, mismatchedGroups: [9] });
    expect(compareManually(enrollment(), [], 0)).toMatchObject({
      match: false,
      mismatchedGroups: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    // Una R sustituida en el camino: la dirección que muestra Recovery no coincide en (casi) ningún grupo.
    const other = addressGroups('0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c');
    const substituted = compareManually(enrollment(), other, 1);
    expect(substituted).toMatchObject({ match: false, attemptsLeft: 1 });
    expect(substituted.match ? [] : substituted.mismatchedGroups).toEqual(
      groups.flatMap((g, i) => (g.toLowerCase() === other[i]?.toLowerCase() ? [] : [i])),
    );
  });

  it('3 intentos por pedido: el tercero fallido deja el pedido abortado y después no se compara más', () => {
    const wrong = groups.map((g, i) => (i === 9 ? (g === 'ffff' ? 'eeee' : 'ffff') : g));
    expect(MANUAL_ATTEMPTS).toBe(3);
    expect(compareManually(enrollment(), wrong, 0)).toMatchObject({ attemptsLeft: 2 });
    expect(compareManually(enrollment(), wrong, 1)).toMatchObject({ attemptsLeft: 1 });
    expect(compareManually(enrollment(), wrong, 2)).toMatchObject({ match: false, attemptsLeft: 0 });
    // Abortado, ni siquiera la dirección correcta lo confirma.
    expect(() => compareManually(enrollment(), groups, 3)).toThrow('se canceló');
  });

  it('sin R informada o con el pedido vencido no hay comparación', () => {
    expect(() => compareManually(enrollment({ status: 'REQUESTED', recoveryKey: null }), groups, 0)).toThrow(
      'todavía no informó',
    );
    expect(() => compareManually(enrollment({ status: 'EXPIRED' }), groups, 0)).toThrow(RecoveryActivationError);
  });

  it('textos: qué grupos revisar, intentos que quedan y qué hacer si la copió bien', () => {
    expect(groupsText([5])).toBe('el grupo 6');
    expect(groupsText([0, 4])).toBe('los grupos 1 y 5');
    expect(groupsText([1, 4, 8])).toBe('los grupos 2, 5 y 9');
    expect(manualRetryText([5], 2)).toBe(
      'Si te equivocaste al copiar, revisá el grupo 6 y volvé a confirmar (te quedan 2 intentos).',
    );
    expect(manualRetryText([0, 9], 1)).toBe(
      'Si te equivocaste al copiar, revisá los grupos 1 y 10 y volvé a confirmar (te queda 1 intento).',
    );
    expect(MANUAL_MISMATCH_TEXT).toBe(
      'No coincide con la dirección que recibió la plataforma. Si la copiaste bien de Recovery, no sigas: alguien pudo haberla cambiado. Generá un pedido nuevo.',
    );
    expect(MANUAL_ABORT_TEXT).toContain('en 3 intentos: se canceló este pedido');
  });
});
