// P15.T07 / P18.MAN: los avisos in-app del backend ([B-MAIL-03]) en texto para el inicio: qué pasó, con la dirección
// completa y su nombre, a dónde ir, y nada inventado si el payload no trae un dato o trae uno inválido.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../api/wallet-api.ts';
import { partsText } from '../operations/describe.ts';
import { addressNames, labelsOf } from '../operations/names.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { notificationView } from './notifications.ts';

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
      new RegExp(`^Se propuso reemplazar tu clave de recuperación \\(R\\) por ${groupAddress(KEY)}; se puede ejecutar`),
    );
    expect(view.link?.to).toBe('/security/rotations');
  });

  it('montos en es-AR: el envío de alto valor (en unidades) y el permiso residual (en unidades mínimas)', () => {
    const high = notificationView(
      notification('HIGH_VALUE_EXECUTED', { token: 'USDC', amount: '1500', destination: DEST, txHash: '0x' }),
    );
    expect(partsText(high.parts)).toBe(`Se ejecutó un envío de alto valor de 1.500,00 USDC a ${groupAddress(DEST)}.`);
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

  it('payload incompleto o inválido: no inventa direcciones ni montos; un tipo desconocido queda genérico', () => {
    const broken = notificationView(notification('WHITELIST_ACTIVATED', { destination: 'no-es-una-direccion' }));
    expect(partsText(broken.parts)).toBe('El destino (dirección no informada) ya está activo: le podés enviar.');
    const noAmount = notificationView(notification('HIGH_VALUE_EXECUTED', { token: 'USDC', destination: DEST }));
    expect(partsText(noAmount.parts)).toBe(`Se ejecutó un envío de alto valor a ${groupAddress(DEST)}.`);
    const unknown = notificationView(notification('ALGO_NUEVO', {}));
    expect(unknown).toEqual({
      tone: 'info',
      parts: [{ kind: 'text', text: 'Aviso de la plataforma (ALGO_NUEVO).' }],
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
    ['ROTATION_EXECUTED', { role: 'U', newKey: KEY }, 'info', `la clave nueva es ${groupAddress(KEY)}.`, null],
    [
      'RECOVERY_STARTED',
      { newKey: KEY },
      'warning',
      'Si no fuiste vos, cancelalo desde las rotaciones.',
      '/security/rotations',
    ],
    [
      'EXECUTOR_ROTATION_REQUESTED',
      { reason: 'MAINTENANCE' },
      'info',
      'La plataforma pidió rotar su clave (S)',
      '/security/rotations',
    ],
    ['EXECUTOR_REPLACED', { newKey: KEY }, 'info', `por ${groupAddress(KEY)}.`, null],
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
