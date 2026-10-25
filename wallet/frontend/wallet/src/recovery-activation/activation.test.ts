// P18.T01 [F-LNK-01/02], ADR-033: enlace a Recovery con el enrollment y el secreto k del pedido en el fragmento, enlace
// de regreso con la R y el mismo k, y confirmación de R: con el enlace tiene que traer el k del pedido (comparado en
// tiempo constante) y su R tiene que ser exactamente la del backend y del mismo enrollment; sin enlace, la dirección
// completa copiada de Recovery (sus 10 grupos, sin distinguir mayúsculas) tiene que coincidir, con 3 intentos por pedido
// y sin revelar los caracteres esperados. Un enrollment vencido o reemplazado no se usa. Cada aborto lleva su motivo
// para el backend (N10; el aviso, en abort-reports.test.ts). Revisión de seguridad de ADR-033 (MEDIO 2): con el k del
// pedido, cualquier respuesta de la plataforma que no sea ese pedido SUBMITTED con esa misma R aborta.
import { describe, expect, it } from 'vitest';
import type { RecoveryEnrollment } from '../api/wallet-api.ts';
import {
  ADDRESS_GROUPS,
  addressGroups,
  compareManually,
  confirmWithReturnLink,
  distributePaste,
  endedRequestText,
  groupsText,
  MANUAL_ABORT_TEXT,
  MANUAL_ATTEMPTS,
  MANUAL_MISMATCH_TEXT,
  manualRetryText,
  nearlyNoneMatch,
  NEW_REQUEST_TEXT,
  newReturnSecret,
  parseRecoveryReturn,
  RecoveryAbortError,
  recoveryEnrollLink,
  RecoveryActivationError,
  RecoveryKeyMismatchError,
  requestExpiryText,
  RESUME_NEW_REQUEST_TEXT,
  RETURN_LINK_ELSEWHERE_TEXT,
  ReturnLinkUnverifiedError,
  sameSecret,
  SESSION_EXPIRED_TEXT,
  submittedRecoveryKey,
  typedGroup,
} from './activation.ts';

const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const K = 'q1Zs-0bM4_Lr8xWp2cYtNg';
/** Un valor que no es una dirección (el backend inconsistente lo podría mandar como R). */
const NOT_AN_ADDRESS = '0xno-es-una-direccion' as const;
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
  it('secreto k: 16 bytes del CSPRNG en base64url, distinto en cada pedido', () => {
    const a = newReturnSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newReturnSecret()).not.toBe(a);
    expect(newReturnSecret((length) => new Uint8Array(length).fill(0xff))).toBe('_____________________w');
  });

  it('enlace de ida con id, nonce y k en el fragmento (no llegan a ningún servidor)', () => {
    const nonce = `0x${'ab'.repeat(32)}` as const;
    const link = recoveryEnrollLink('https://recovery.example', { enrollmentId: ID, nonce }, K);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://recovery.example/enroll');
    expect(url.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({ eid: ID, n: nonce, k: K });
    expect(() => recoveryEnrollLink('https://recovery.example', { enrollmentId: ID, nonce }, 'corto')).toThrow(
      RecoveryActivationError,
    );
  });

  it('enlace de regreso: id y R válidos o nada; k sólo si tiene la forma de uno', () => {
    expect(parseRecoveryReturn(`#eid=${ID}&r=${R.toLowerCase()}&k=${K}`)).toEqual({
      enrollmentId: ID,
      recoveryKey: R,
      secret: K,
    });
    expect(parseRecoveryReturn(`#eid=${ID}&r=${R}`)).toEqual({ enrollmentId: ID, recoveryKey: R, secret: null });
    expect(parseRecoveryReturn(`#eid=${ID}&r=${R}&k=no-es-un-k`)).toMatchObject({ secret: null });
    expect(parseRecoveryReturn(`#eid=no-es-uuid&r=${R}`)).toBeNull();
    expect(parseRecoveryReturn(`#eid=${ID}&r=0x1234`)).toBeNull();
    expect(parseRecoveryReturn('')).toBeNull();
  });

  it('el k se compara completo: otro, más corto o ausente no coincide', () => {
    expect(sameSecret(K, K)).toBe(true);
    expect(sameSecret(K, `${K.slice(0, 21)}h`)).toBe(false);
    expect(sameSecret(K, `h${K.slice(1)}`)).toBe(false);
    expect(sameSecret(K, K.slice(0, 21))).toBe(false);
    expect(sameSecret(K, null)).toBe(false);
  });

  it('mientras Recovery no informó R no hay nada que confirmar; vencido o reemplazado falla', () => {
    expect(submittedRecoveryKey(enrollment({ status: 'REQUESTED', recoveryKey: null }))).toBeNull();
    expect(submittedRecoveryKey(enrollment())).toBe(R);
    for (const status of ['EXPIRED', 'REJECTED', 'RETIRED'] as const) {
      expect(() => submittedRecoveryKey(enrollment({ status }))).toThrow(RecoveryActivationError);
    }
  });

  it('con enlace de regreso: el k del pedido, la R del backend y el mismo pedido', () => {
    const fromLink = { enrollmentId: ID, recoveryKey: R, secret: K } as const;
    expect(confirmWithReturnLink(enrollment(), fromLink, K)).toBe(R);
    // Sin k o con otro: no lo armó la app Recovery, aunque traiga la R correcta (un backend comprometido conoce las dos).
    for (const secret of [null, newReturnSecret()]) {
      const unverified = () => confirmWithReturnLink(enrollment(), { ...fromLink, secret }, K);
      expect(unverified).toThrow(ReturnLinkUnverifiedError);
      expect(unverified).toThrow('no armó tu app Recovery para este pedido');
    }
    try {
      confirmWithReturnLink(enrollment(), { ...fromLink, secret: null }, K);
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryAbortError);
      expect((error as RecoveryAbortError).reason).toBe('RETURN_LINK_UNVERIFIED');
    }
    // Con el k pero otra R: aborta (la R cambió en el camino).
    const otherKey = () =>
      confirmWithReturnLink(
        enrollment(),
        { ...fromLink, recoveryKey: '0x000000000000000000000000000000000000dEaD' },
        K,
      );
    expect(otherKey).toThrow(RecoveryKeyMismatchError);
    expect(otherKey).toThrow('alguien pudo haberla cambiado en el camino. Se canceló este pedido.');
    expect(new RecoveryKeyMismatchError().reason).toBe('RETURN_LINK_KEY_MISMATCH');
    // Con el k, el enlace es auténtico: si la plataforma informa otro pedido, ninguna R u otro estado, también aborta
    // como otra R (un backend comprometido no puede dejar el pedido vivo con una respuesta rara).
    for (const inconsistent of [
      enrollment({ id: '11111111-1111-4111-8111-111111111111' }),
      enrollment({ status: 'REQUESTED', recoveryKey: null }),
      enrollment({ recoveryKey: null }),
      ...(['CONFIRMED', 'EXPIRED', 'REJECTED', 'RETIRED'] as const).map((status) => enrollment({ status })),
      enrollment({ recoveryKey: NOT_AN_ADDRESS }),
    ]) {
      expect(() => confirmWithReturnLink(inconsistent, fromLink, K), JSON.stringify(inconsistent)).toThrow(
        RecoveryKeyMismatchError,
      );
    }
    // Las mayúsculas del id y de la dirección no importan.
    expect(
      confirmWithReturnLink(
        enrollment({ id: ID.toUpperCase(), recoveryKey: R.toLowerCase() as `0x${string}` }),
        fromLink,
        K,
      ),
    ).toBe(R);
  });

  it('un pedido que la plataforma da por terminado: qué pasó, en texto de la app (vigente → null)', () => {
    expect(endedRequestText({ status: 'REQUESTED' })).toBeNull();
    expect(endedRequestText({ status: 'SUBMITTED' })).toBeNull();
    expect(endedRequestText({ status: 'EXPIRED' })).toContain('venció');
    expect(endedRequestText({ status: 'REJECTED', rejectionReason: 'SUPERSEDED' })).toContain('reemplazado por otro');
    expect(endedRequestText({ status: 'REJECTED', rejectionReason: 'RETURN_LINK_UNVERIFIED' })).toContain('se canceló');
    expect(endedRequestText({ status: 'REJECTED' })).toContain('se canceló');
    expect(endedRequestText({ status: 'RETIRED' })).toBe('Este pedido ya no está vigente.');
    expect(endedRequestText({ status: 'CONFIRMED' })).toBe('Este pedido ya no está vigente.');
  });

  it('vencimiento del pedido con la hora que informa el backend', () => {
    expect(requestExpiryText('2026-10-18T15:15:00Z', 'America/Argentina/Buenos_Aires')).toBe(
      'Este pedido vence a las 12:15: si Recovery no informa la dirección antes, vas a tener que generar otro.',
    );
    expect(NEW_REQUEST_TEXT).toBe(
      'Escaneá el QR nuevo: Recovery va a crear otra clave R; destruí los backups de la anterior.',
    );
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

  it('textos: qué grupos revisar (sin doble «y»), intentos que quedan y qué hacer si no parece un error de tipeo', () => {
    expect(groupsText([5])).toBe('el grupo 6');
    expect(groupsText([0, 4])).toBe('los grupos 1 y 5');
    expect(groupsText([1, 4, 8])).toBe('los grupos 2, 5 y 9');
    expect(manualRetryText([5], 2)).toBe(
      'Si te equivocaste al copiar, revisá el grupo 6 y volvé a confirmar (te quedan 2 intentos).',
    );
    expect(manualRetryText([1, 4], 1)).toBe(
      'Si te equivocaste al copiar, revisá los grupos 2 y 5, y volvé a confirmar (te queda 1 intento).',
    );
    // Ninguno o casi ninguno: no parece un error de tipeo y se recomienda no seguir.
    const all = Array.from({ length: ADDRESS_GROUPS }, (_, i) => i);
    // También dice cuántos intentos quedan (hallazgo 6 de la tercera revisión de P17.MAN).
    expect(manualRetryText(all, 2)).toBe(
      'No coincide ningún grupo: no parece un error de tipeo (te quedan 2 intentos). No sigas con este pedido: generá uno nuevo.',
    );
    expect(manualRetryText(all.slice(1), 2)).toBe(
      'Coincide sólo 1 grupo de 10: no parece un error de tipeo (te quedan 2 intentos). No sigas con este pedido: generá uno nuevo.',
    );
    expect(manualRetryText(all.slice(2), 1)).toBe(
      'Coinciden sólo 2 grupos de 10: no parece un error de tipeo (te queda 1 intento). No sigas con este pedido: generá uno nuevo.',
    );
    expect(manualRetryText(all.slice(3), 1)).toMatch(/^Si te equivocaste al copiar, revisá los grupos 4, 5, 6/);
    // Con ninguno o casi ninguno, generar un pedido nuevo es la acción principal; con 3 o más, revisar y confirmar.
    expect(nearlyNoneMatch(all)).toBe(true);
    expect(nearlyNoneMatch(all.slice(2))).toBe(true);
    expect(nearlyNoneMatch(all.slice(3))).toBe(false);
    expect(nearlyNoneMatch([5])).toBe(false);
    expect(MANUAL_MISMATCH_TEXT).toBe(
      'No coincide con la dirección que recibió la plataforma. Si la copiaste bien de Recovery, no sigas: alguien pudo haberla cambiado. Generá un pedido nuevo.',
    );
    expect(MANUAL_ABORT_TEXT).toContain('en 3 intentos: se canceló este pedido');
  });

  it('pegar la dirección completa la reparte en los 10 grupos; un pedazo sigue desde el campo; 4 o menos, como siempre', () => {
    const empty = Array.from({ length: ADDRESS_GROUPS }, () => '');
    // Como la copia el botón de Recovery (sin espacios) o como se ve en pantalla (0x y grupos), en cualquier campo.
    expect(distributePaste(empty, 0, R)).toEqual(groups);
    expect(distributePaste(empty, 3, `0x ${groups.join(' ')}`)).toEqual(groups);
    expect(distributePaste(empty, 7, R.slice(2).toLowerCase())).toEqual(groups.map((g) => g.toLowerCase()));
    // Un pedazo más largo que un grupo sigue desde ese campo (y lo que sobra no pisa nada fuera de los 10).
    const partial = distributePaste(empty, 8, `${groups[8] ?? ''} ${groups[9] ?? ''} abcd`);
    expect(partial).toEqual([...empty.slice(0, 8), groups[8], groups[9]]);
    expect(distributePaste(['', 'x', '', '', '', '', '', '', '', ''], 2, 'aaaabbbb')).toEqual([
      '',
      'x',
      'aaaa',
      'bbbb',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(distributePaste(empty, 0, 'abcd')).toBeNull();
    expect(distributePaste(empty, 0, ' 0xab ')).toBeNull();
  });

  it('un «0x» tipeado al principio del Grupo 1 se ignora: no corre los grupos ni cuenta como error (hallazgo 5)', () => {
    // Lo que queda en el campo mientras se tipea: «0» puede ser el comienzo de un grupo; «0x», nunca.
    expect(typedGroup(0, '0')).toBe('0');
    expect(typedGroup(0, '0x')).toBe('');
    expect(typedGroup(0, '0X7')).toBe('7');
    expect(typedGroup(0, ' 0x71')).toBe('71');
    expect(typedGroup(0, groups[0] ?? '')).toBe(groups[0]);
    // En los demás grupos no se toca nada (y ahí no coincide).
    expect(typedGroup(3, '0x12')).toBe('0x12');
    // Al comparar, también: el primer grupo con «0x» delante coincide.
    const withPrefix = groups.map((g, i) => (i === 0 ? `0x${g}` : g));
    expect(compareManually(enrollment(), withPrefix, 0)).toEqual({ match: true, recoveryKey: R });
    expect(
      compareManually(
        enrollment(),
        groups.map((g, i) => (i === 0 ? `0X ${g}` : g)),
        0,
      ),
    ).toEqual({
      match: true,
      recoveryKey: R,
    });
    expect(
      compareManually(
        enrollment(),
        groups.map((g, i) => (i === 4 ? `0x${g}` : g)),
        0,
      ),
    ).toMatchObject({
      match: false,
      mismatchedGroups: [4],
    });
  });

  it('textos del paso: retomar con un pedido anterior, verificación vencida y el enlace en una pestaña sin el pedido', () => {
    expect(RESUME_NEW_REQUEST_TEXT).toBe(
      'Al seguir vas a activar Recovery de nuevo: Recovery va a crear otra clave R y los backups de la anterior no van a servir.',
    );
    expect(SESSION_EXPIRED_TEXT).toBe('Tu verificación venció: confirmá que sos vos de nuevo para generar el pedido.');
    // La pestaña sin el pedido también explica cómo confirmar a mano en la del pedido.
    expect(RETURN_LINK_ELSEWHERE_TEXT).toContain(
      'o confirmá ahí la dirección a mano: tipeá los 10 grupos que muestra la app Recovery después del «0x»',
    );
  });
});
