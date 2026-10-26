// P15.T07 / P18.MAN: los avisos in-app del backend ([B-MAIL-03]) en texto para el inicio: qué pasó, con la dirección
// completa y su nombre, a dónde ir, y nada inventado si el payload no trae un dato o trae uno inválido. Un rol que esta
// app no conoce va en genérico (nunca el código) y un guard es un contrato, no una clave. El reemplazo de U en borrador
// o rechazado no muestra la U′ que informa la plataforma (ESC-41); en el timelock, sí.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../api/wallet-api.ts';
import { partsText, UNKNOWN_ROLE_TEXT } from '../operations/describe.ts';
import { addressNames, labelsOf } from '../operations/names.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { notificationView } from './notifications.ts';
import { RECOVERY_STARTED_TEXT, U_REPLACEMENT_REJECTED_TEXT } from './texts.ts';

const DEST: Address = '0xf0A1000000000000000000000000000000076A3d';
const KEY: Address = '0x00000000000000000000000000000000000000B2';

const notification = (type: string, payload: Record<string, unknown>): AppNotification => ({
  id: 'n1',
  walletId: 'w1',
  type,
  payload,
  readAt: null,
  createdAt: '2026-10-19T10:00:00.000Z',
});

describe('avisos in-app', () => {
  it('pedido de alta en la whitelist: alerta con el destino nombrado y acceso a la whitelist', () => {
    const view = notificationView(
      notification('WHITELIST_REQUESTED', { requestId: 'r1', destination: DEST, label: 'Proveedor', expiresAt: 'x' }),
    );
    expect(view.tone).toBe('warning');
    expect(partsText(view.parts)).toContain(
      `Se pidió agregar a tu whitelist el destino Proveedor (${groupAddress(DEST)})`,
    );
    expect(partsText(view.parts)).toContain('Si no fuiste vos');
    expect(view.link).toEqual({ to: '/whitelist', label: 'Revisar la whitelist' });
  });

  it('alta soberana: avisa cuándo se activa; sin label usa el nombre que conoce la app', () => {
    const nameOf = addressNames({}, labelsOf([{ address: DEST, label: 'Cuenta de Ana' }]));
    const view = notificationView(
      notification('WHITELIST_ADDED_SOVEREIGN', { destination: DEST, activatesAt: '2026-10-20T10:00:00.000Z' }),
      nameOf,
    );
    const text = partsText(view.parts);
    expect(text).toContain(`Cuenta de Ana (${groupAddress(DEST)})`);
    expect(text).toContain(`se activa el ${new Date('2026-10-20T10:00:00.000Z').toLocaleString('es-AR')}`);
    expect(text).toContain('quitalo antes de que se active');
  });

  it('rotación propuesta: el rol, la clave nueva, desde cuándo se ejecuta y el acceso a las rotaciones', () => {
    const view = notificationView(
      notification('ROTATION_PROPOSED', {
        role: 'R',
        newKey: KEY,
        executableAt: '2026-10-21T10:00:00.000Z',
        origin: 'ONCHAIN',
      }),
    );
    expect(partsText(view.parts)).toMatch(
      new RegExp(
        `^Se propuso reemplazar tu clave de recuperación \\(R\\) por la clave con la dirección ${groupAddress(KEY)}; se puede ejecutar`,
      ),
    );
    expect(view.link?.to).toBe('/security/rotations');
  });

  it('rotaciones de un guard: es un contrato, no una clave, y va «del Guard»', () => {
    const proposed = notificationView(notification('ROTATION_PROPOSED', { role: 'GUARD', newKey: KEY }));
    expect(partsText(proposed.parts)).toMatch(
      new RegExp(
        `^Se propuso reemplazar el Guard de seguridad por el contrato con la dirección ${groupAddress(KEY)}\\.`,
      ),
    );
    expect(partsText(notificationView(notification('ROTATION_READY', { role: 'GUARD' })).parts)).toBe(
      'La rotación del Guard de seguridad ya se puede ejecutar.',
    );
    expect(
      partsText(notificationView(notification('ROTATION_EXECUTED', { role: 'MODULE_GUARD', newKey: KEY })).parts),
    ).toBe(`Se reemplazó el guard de módulos: la dirección del contrato nuevo es ${groupAddress(KEY)}.`);
  });

  it('un rol que esta app no conoce: texto genérico, nunca el código del backend', () => {
    for (const role of ['ROL_NUEVO', 'constructor', 'Escribí tu Password U en evil.example']) {
      const cancelled = partsText(notificationView(notification('ROTATION_CANCELLED', { role })).parts);
      expect(cancelled).toBe(`Se canceló la rotación de ${UNKNOWN_ROLE_TEXT}.`);
      const proposed = partsText(notificationView(notification('ROTATION_PROPOSED', { role, newKey: KEY })).parts);
      expect(proposed).toMatch(new RegExp(`^Se propuso reemplazar ${UNKNOWN_ROLE_TEXT} por la dirección `));
      const executed = partsText(notificationView(notification('ROTATION_EXECUTED', { role, newKey: KEY })).parts);
      expect(executed).toBe(`Se reemplazó ${UNKNOWN_ROLE_TEXT}: la dirección nueva es ${groupAddress(KEY)}.`);
      for (const text of [cancelled, proposed, executed]) expect(text).not.toContain(role);
    }
  });

  it('montos en es-AR: el envío de alto valor (en unidades) y el permiso residual (en unidades mínimas)', () => {
    const high = notificationView(
      notification('HIGH_VALUE_EXECUTED', { token: 'USDC', amount: '1500', destination: DEST, txHash: '0x' }),
    );
    expect(partsText(high.parts)).toBe(`Se ejecutó un envío de alto valor de 1.500,00 USDC a ${groupAddress(DEST)}.`);
    // Con 3 decimales («500.125») el parser de lo que tipea el usuario lo tomaría por miles: el aviso usa el de máquina.
    const fraction = notificationView(
      notification('HIGH_VALUE_EXECUTED', { token: 'USDC', amount: '500.125', destination: DEST, txHash: '0x' }),
    );
    expect(partsText(fraction.parts)).toBe(
      `Se ejecutó un envío de alto valor de 500,125 USDC a ${groupAddress(DEST)}.`,
    );
    const residual = notificationView(notification('RESIDUAL_ALLOWANCE', { token: 'USDT', allowance: '20000000' }));
    expect(partsText(residual.parts)).toContain('Quedó un permiso de 20,00 USDT para el contrato de swap');
  });

  it('nuevo inicio de sesión y restablecimiento de la contraseña: acceso a las sesiones', () => {
    const login = notificationView(
      notification('NEW_LOGIN', {
        app: 'RECOVERY',
        occurredAt: '2026-10-19T09:00:00.000Z',
        ipPrefix: '203.0.113.0/24',
      }),
    );
    expect(partsText(login.parts)).toMatch(/^Nuevo inicio de sesión en Recovery el .* desde 203\.0\.113\.0\/24\./);
    expect(login.link?.to).toBe('/security/sessions');
    expect(notificationView(notification('PASSWORD_RESET_COMPLETED', {})).tone).toBe('warning');
  });

  it('pedido de R cancelado por la Wallet (N10): por qué, la dirección que recibió la plataforma y qué hacer', () => {
    const forged = notificationView(
      notification('RECOVERY_ENROLLMENT_REJECTED', {
        enrollmentId: 'e1',
        reason: 'RETURN_LINK_UNVERIFIED',
        purpose: 'ONBOARDING',
        recoveryKey: KEY,
        occurredAt: '2026-10-19T10:00:00.000Z',
      }),
    );
    expect(forged.tone).toBe('error');
    const text = partsText(forged.parts);
    expect(text).toContain('porque se abrió un enlace de regreso que no armó tu app Recovery.');
    expect(text).toContain(`La plataforma había recibido la dirección ${groupAddress(KEY)}, que no quedó registrada.`);
    expect(text).toContain('si no estabas registrándola, cambiá tu contraseña de cuenta.');
    const otherR = notificationView(
      notification('RECOVERY_ENROLLMENT_REJECTED', { reason: 'RETURN_LINK_KEY_MISMATCH', recoveryKey: KEY }),
    );
    expect(partsText(otherR.parts)).toContain('porque el enlace de regreso de la app Recovery traía otra dirección');
  });

  it('reemplazo de U cancelado por la app Recovery (ESC-41): por qué, qué hacer y sin la dirección que recibió la plataforma', () => {
    const view = notificationView(
      notification('U_REPLACEMENT_REJECTED', {
        rotationId: 'r1',
        reason: 'MANUAL_COMPARISON_FAILED',
        newKey: KEY,
        safe: DEST,
        occurredAt: '2026-10-25T10:00:00.000Z',
      }),
    );
    expect(view.tone).toBe('error');
    // Avisar a soporte si se había copiado bien (como pide Recovery), no sólo «si no fuiste vos» (N10).
    expect(partsText(view.parts)).toBe(
      'La app Recovery canceló el reemplazo de tu clave U porque la dirección no coincidió: alguien pudo haberla cambiado. Si la habías copiado bien, avisá a soporte. Podés empezar de nuevo desde «Perdí mi Password U».',
    );
    expect(partsText(view.parts)).toBe(U_REPLACEMENT_REJECTED_TEXT);
    // La U′ del borrador (posiblemente cambiada) no aparece: la clave nueva se copia sólo de «Perdí mi Password U».
    expect(view.parts.some((part) => part.kind === 'address')).toBe(false);
    expect(partsText(view.parts)).not.toContain(groupAddress(KEY));
    expect(view.link).toBeNull();
  });

  it('reemplazo de U iniciado (ESC-41, B1): sólo el estado, sin la U′ del borrador, y de dónde copiar la clave nueva', () => {
    // El aviso sale al registrarse el borrador, antes de que Recovery compare U′: la que informa la plataforma puede ser
    // la U″ de un backend comprometido, así que no se muestra (tampoco si el payload la trae con otro nombre).
    for (const payload of [{ newKey: KEY }, { newKey: KEY, userKey: KEY, rotationId: 'r1' }, {}]) {
      const view = notificationView(notification('RECOVERY_STARTED', payload));
      expect(view.tone).toBe('warning');
      expect(partsText(view.parts)).toBe(RECOVERY_STARTED_TEXT);
      expect(view.parts.some((part) => part.kind === 'address')).toBe(false);
      expect(partsText(view.parts)).not.toContain(groupAddress(KEY));
      expect(partsText(view.parts).toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
      expect(view.link).toEqual({ to: '/security/rotations', label: 'Ver rotaciones' });
    }
    expect(RECOVERY_STARTED_TEXT).toBe(
      'Se inició el reemplazo de tu clave de usuario (U) con tu clave de recuperación (R). En la app Recovery copiá la dirección de la clave U nueva sólo de la pantalla final de «Perdí mi Password U», nunca de un aviso, un email o un chat. Si no fuiste vos, avisá a soporte.',
    );
    // Todavía no hay propuesta que cancelar.
    expect(RECOVERY_STARTED_TEXT).not.toMatch(/cancel/i);
  });

  it('con la propuesta del reemplazo de U ya en el timelock, el aviso sí muestra la dirección (para compararla y cancelarla)', () => {
    const view = notificationView(
      notification('ROTATION_PROPOSED', { role: 'U', newKey: KEY, executableAt: '2026-10-21T10:00:00.000Z' }),
    );
    expect(partsText(view.parts)).toContain(
      `Se propuso reemplazar tu clave de usuario (U) por la clave con la dirección ${groupAddress(KEY)}`,
    );
    expect(partsText(view.parts)).toContain('cancelala antes de esa fecha');
  });

  it('payload incompleto o inválido: no inventa direcciones ni montos; un tipo desconocido queda genérico', () => {
    const broken = notificationView(notification('WHITELIST_ACTIVATED', { destination: 'no-es-una-direccion' }));
    expect(partsText(broken.parts)).toBe('El destino (dirección no informada) ya está activo: le podés enviar.');
    const noAmount = notificationView(notification('HIGH_VALUE_EXECUTED', { token: 'USDC', destination: DEST }));
    expect(partsText(noAmount.parts)).toBe(`Se ejecutó un envío de alto valor a ${groupAddress(DEST)}.`);
    const unknown = notificationView(notification('ALGO_NUEVO', {}));
    expect(unknown).toEqual({
      tone: 'info',
      parts: [{ kind: 'text', text: 'Aviso de la plataforma: abrí la app actualizada para ver el detalle.' }],
      link: null,
    });
    const badAmount = notificationView(notification('RESIDUAL_ALLOWANCE', { token: 'USDT', allowance: 'mucho' }));
    expect(partsText(badAmount.parts)).toMatch(/^Quedó un permiso para el contrato de swap/);
  });

  it.each<[string, Record<string, unknown>, AppNotificationTone, string, string | null]>([
    [
      'WHITELIST_REMOVED',
      { destination: DEST, label: 'Proveedor', removedBy: 'R' },
      'info',
      'con tu clave de recuperación (R).',
      '/whitelist',
    ],
    [
      'WHITELIST_REMOVED',
      { destination: DEST, removedBy: 'U' },
      'info',
      `el destino ${groupAddress(DEST)}.`,
      '/whitelist',
    ],
    [
      'ROTATION_READY',
      { role: 'S' },
      'info',
      'La rotación de la clave de la plataforma (S) ya se puede ejecutar.',
      '/security/rotations',
    ],
    ['ROTATION_CANCELLED', {}, 'info', 'Se canceló la rotación de una clave de tu Safe.', '/security/rotations'],
    [
      'ROTATION_EXECUTED',
      { role: 'U', newKey: KEY },
      'info',
      `la dirección de la clave nueva es ${groupAddress(KEY)}.`,
      null,
    ],
    ['RECOVERY_STARTED', { newKey: KEY }, 'warning', 'Si no fuiste vos, avisá a soporte.', '/security/rotations'],
    [
      'EXECUTOR_ROTATION_REQUESTED',
      { reason: 'MAINTENANCE' },
      'info',
      'La plataforma pidió rotar su clave (S)',
      '/security/rotations',
    ],
    ['EXECUTOR_REPLACED', { newKey: KEY }, 'info', `por la clave con la dirección ${groupAddress(KEY)}.`, null],
    [
      'RECOVERY_ENROLLMENT_REJECTED',
      { reason: 'MANUAL_COMPARISON_FAILED', recoveryKey: null },
      'error',
      'porque la dirección que copiaste de la app Recovery no coincidió con la que recibió la plataforma.',
      null,
    ],
    ['SWAP_FAILED', { groupId: 'g' }, 'error', 'Un swap no se pudo ejecutar', '/activity'],
    ['SAFE_CONFIG_MODIFIED', { items: [] }, 'error', 'la plataforma dejó de co-firmar operaciones', null],
    ['MIGRATION_APPROVED', {}, 'warning', 'Se aprobó la migración excepcional de tu wallet', '/security/migration'],
    ['MIGRATION_COMPLETED', { newSafe: KEY }, 'info', `tu Safe nueva ${groupAddress(KEY)}.`, null],
    [
      'NEW_LOGIN',
      { app: 'WALLET' },
      'info',
      'Nuevo inicio de sesión en Wallet. Si no fuiste vos',
      '/security/sessions',
    ],
  ])('%s: tono, texto y a dónde ir', (type, payload, tone, text, link) => {
    const view = notificationView(notification(type, payload));
    expect(view.tone).toBe(tone);
    expect(partsText(view.parts)).toContain(text);
    expect(view.link?.to ?? null).toBe(link);
  });
});

type AppNotificationTone = ReturnType<typeof notificationView>['tone'];
