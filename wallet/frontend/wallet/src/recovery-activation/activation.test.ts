// P18.T01 [F-LNK-01/02]: link a Recovery con el enrollment en el fragmento, link de regreso con la R, y confirmación de
// R: con el link tiene que ser exactamente la del backend y del mismo enrollment; sin link, la dirección completa copiada
// de Recovery (sus 10 grupos) tiene que coincidir. Un enrollment vencido o reemplazado no se usa.
import { describe, expect, it } from 'vitest';
import type { RecoveryEnrollment } from '../api/wallet-api.ts';
import {
  addressGroups,
  confirmManually,
  confirmWithReturnLink,
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
  it('link de ida con id y nonce en el fragmento (no llegan a ningún servidor)', () => {
    const nonce = `0x${'ab'.repeat(32)}` as const;
    const link = recoveryEnrollLink('https://recovery.example', { enrollmentId: ID, nonce });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://recovery.example/enroll');
    expect(url.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ eid: ID, n: nonce });
  });

  it('link de regreso: id y R válidos o nada', () => {
    expect(parseRecoveryReturn(`#eid=${ID}&r=${R.toLowerCase()}`)).toEqual({ enrollmentId: ID, recoveryKey: R });
    expect(parseRecoveryReturn(`#eid=no-es-uuid&r=${R}`)).toBeNull();
    expect(parseRecoveryReturn(`#eid=${ID}&r=0x1234`)).toBeNull();
    expect(parseRecoveryReturn('')).toBeNull();
  });

  it('mientras Recovery no envió R no hay nada que confirmar; vencido o reemplazado falla', () => {
    expect(submittedRecoveryKey(enrollment({ status: 'REQUESTED', recoveryKey: null }))).toBeNull();
    expect(submittedRecoveryKey(enrollment())).toBe(R);
    for (const status of ['EXPIRED', 'REJECTED', 'RETIRED'] as const) {
      expect(() => submittedRecoveryKey(enrollment({ status }))).toThrow(RecoveryActivationError);
    }
  });

  it('con link de regreso: la R tiene que ser la del backend y del mismo pedido', () => {
    expect(confirmWithReturnLink(enrollment(), { enrollmentId: ID, recoveryKey: R })).toBe(R);
    // Otra R aborta la activación (error propio, la UI pide un enrollment nuevo); otro pedido es otro error.
    const otherKey = () =>
      confirmWithReturnLink(enrollment(), {
        enrollmentId: ID,
        recoveryKey: '0x000000000000000000000000000000000000dEaD',
      });
    expect(otherKey).toThrow(RecoveryKeyMismatchError);
    expect(otherKey).toThrow('se cancela la activación');
    const otherRequest = () =>
      confirmWithReturnLink(enrollment(), { enrollmentId: '11111111-1111-4111-8111-111111111111', recoveryKey: R });
    expect(otherRequest).toThrow('otro pedido');
    expect(otherRequest).not.toThrow(RecoveryKeyMismatchError);
    expect(() =>
      confirmWithReturnLink(enrollment({ status: 'REQUESTED', recoveryKey: null }), {
        enrollmentId: ID,
        recoveryKey: R,
      }),
    ).toThrow('todavía no envió');
  });

  it('sin link: la dirección completa (los 10 grupos) tiene que coincidir con la R del backend', () => {
    const groups = addressGroups(R);
    expect(groups).toHaveLength(10);
    expect(groups.join('')).toBe(R.slice(2));
    const typed = groups.map((g) => ` ${g.toLowerCase()} `);
    expect(confirmManually(enrollment(), typed)).toBe(R);
    // Un solo grupo distinto, uno vacío o menos grupos: no se confirma.
    for (const index of [0, 5, 9]) {
      expect(() =>
        confirmManually(
          enrollment(),
          typed.map((g, i) => (i === index ? '0000' : g)),
        ),
      ).toThrow(RecoveryActivationError);
      expect(() =>
        confirmManually(
          enrollment(),
          typed.map((g, i) => (i === index ? '' : g)),
        ),
      ).toThrow(RecoveryActivationError);
    }
    expect(() => confirmManually(enrollment(), typed.slice(0, 9))).toThrow(RecoveryActivationError);
    expect(() => confirmManually(enrollment(), [])).toThrow(RecoveryActivationError);
    expect(() => confirmManually(enrollment({ status: 'REQUESTED', recoveryKey: null }), typed)).toThrow(
      'todavía no envió',
    );
  });
});
