// Review de P18: cada tipo de operación decodificada tiene su texto (montos es-AR y direcciones agrupadas), lo no
// reconocido se anuncia como no firmable, y todos los estados del pipeline tienen texto. P18.MAN: el destino aparece con
// su nombre (label de la whitelist entre «» o contrato del sistema) y la dirección completa al lado; el permiso del swap
// nombra al contrato de swap de la plataforma; el vencimiento del swap se mide con la hora de la cadena (la última
// lectura más lo que pasó desde entonces) y se muestra en la del dispositivo; ya ejecutada, la operación se cuenta en
// pasado; cada estado que se puede ver tiene su ayuda y los motivos van en texto, nunca como código crudo. Tercera
// revisión independiente: una clave o un contrato se nombran por su dirección («la dirección de tu clave…»), cada rol
// con su artículo («del Guard», «de la clave de la plataforma (S)») y un rol o un estado desconocidos, en genérico.
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { OperationState, OperationStatus } from '../api/wallet-api.ts';
import type { DecodedCall } from '../chain/decoders.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { decodeContext, onchainNonce } from './context.ts';
import {
  chainNowAt,
  deadlineRemainingMs,
  describeCall,
  describeParts,
  expiryText,
  isRotationRole,
  ofRole,
  operationReason,
  partsText,
  roleText,
  stateLabel,
  STATE_HELP,
  STATE_TEXT,
  swapDeadline,
  SWAP_SIGN_MARGIN_MS,
  UNKNOWN_ROLE_TEXT,
  UNKNOWN_STATE_TEXT,
} from './describe.ts';
import { addressNames, labelsOf, POOL_NAME, shownLabels } from './names.ts';

// La config embebida del build (módulo virtual de Vite) no existe en Vitest: se reemplaza por una mínima.
vi.mock('../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: { contracts: {}, signerAttestationPublicKey: '' },
}));

const A: Address = '0x000000000000000000000000000000000000dEaD';
const Z: Address = '0x0000000000000000000000000000000000000000';
const EXECUTOR: Address = '0xF01c000000000000000000000000000000005830';
const SAFE: Address = '0x00000000000000000000000000000000000000A1';
const system = {
  contracts: { swapExecutor: { name: 'SwapExecutorV3', address: EXECUTOR, codehash: '0x' } },
} as unknown as Pick<SystemContracts, 'contracts'>;

describe('texto de las operaciones', () => {
  it.each<[DecodedCall, RegExp]>([
    [{ kind: 'NOOP' }, /vacía/],
    [{ kind: 'TRANSFER', token: 'USDC', recipient: A, amount: 1_500_000n }, /Enviar 1,50 USDC a 0x 0000/],
    [
      { kind: 'APPROVE', token: 'USDT', spender: A, amount: 0n, spenderIsSwapExecutor: false },
      /Revocar el permiso sobre tus USDT/,
    ],
    [
      { kind: 'APPROVE', token: 'USDC', spender: A, amount: 2_000_000n, spenderIsSwapExecutor: false },
      /exactamente 2,00 USDC de tu Safe$/,
    ],
    [
      {
        kind: 'SWAP',
        tokenIn: 'USDC',
        tokenOut: 'USDT',
        amountIn: 1_000_000n,
        minAmountOut: 990_000n,
        deadline: 1_792_189_000n,
      },
      /Cambiar 1,00 USDC por al menos 0,99 USDT, que llegan a tu Safe; vence el .* \(hora de la cadena\)/,
    ],
    [{ kind: 'WHITELIST_ADD', destination: A }, /Agregar a tu whitelist/],
    [{ kind: 'WHITELIST_REMOVE', destination: A }, /Quitar de tu whitelist/],
    [
      { kind: 'ROTATION_PROPOSE', role: 'S', oldValue: A, newValue: A },
      /^Proponer reemplazar la dirección de la clave de la plataforma \(S\) 0x /,
    ],
    [{ kind: 'ROTATION_CANCEL', proposalId: `0x${'1'.repeat(64)}` }, /Cancelar la propuesta/],
    [
      { kind: 'ROTATION_EXECUTE', prevOwner: A, oldOwner: A, newOwner: A },
      /^Reemplazar en la Safe la dirección de la clave actual 0x .+ por la de la clave nueva 0x /,
    ],
    [{ kind: 'GUARD_UPGRADE', target: 'GUARD', newGuard: Z }, /Quitar el Guard de seguridad/],
    [{ kind: 'GUARD_UPGRADE', target: 'MODULE_GUARD', newGuard: A }, /Cambiar el guard de módulos a/],
    [
      { kind: 'GUARD_ROLES_UPDATE', userKey: A, recoveryKey: A, executor: A },
      /^Registrar en el Guard las direcciones de las claves U 0x .+, R 0x .+ y S 0x /,
    ],
    [{ kind: 'UNKNOWN', reason: 'DELEGATECALL' }, /no se firma/],
  ])('texto de %#', (call, text) => {
    expect(describeCall(call)).toMatch(text);
  });

  it('el destino con su nombre de la whitelist y la dirección completa; monto y token como parte destacada', () => {
    const nameOf = addressNames(
      { safe: SAFE, system },
      shownLabels(labelsOf([{ address: A, label: 'Cuenta de Ana' }])),
    );
    const call: DecodedCall = { kind: 'TRANSFER', token: 'USDC', recipient: A, amount: 1_500_000n };
    const parts = describeParts(call, { nameOf });
    expect(parts).toEqual([
      { kind: 'text', text: 'Enviar ' },
      { kind: 'amount', text: '1,50 USDC' },
      { kind: 'text', text: ' a ' },
      { kind: 'address', address: A, name: '«Cuenta de Ana»' },
    ]);
    expect(partsText(parts)).toBe(`Enviar 1,50 USDC a «Cuenta de Ana» (${groupAddress(A)})`);
    expect(describeCall({ kind: 'WHITELIST_ADD', destination: A }, { nameOf })).toBe(
      `Agregar a tu whitelist el destino «Cuenta de Ana» (${groupAddress(A)}) (se activa 24 h después)`,
    );
  });

  it('ya ejecutada, la operación se cuenta en pasado (sin el plazo del swap)', () => {
    const nameOf = addressNames(
      { safe: SAFE, system },
      shownLabels(labelsOf([{ address: A, label: 'Cuenta de Ana' }])),
    );
    const done = { nameOf, done: true };
    expect(describeCall({ kind: 'TRANSFER', token: 'USDC', recipient: A, amount: 1_500_000n }, done)).toBe(
      `Enviaste 1,50 USDC a «Cuenta de Ana» (${groupAddress(A)})`,
    );
    const approve: DecodedCall = {
      kind: 'APPROVE',
      token: 'USDC',
      spender: EXECUTOR,
      amount: 20_000_000n,
      spenderIsSwapExecutor: true,
    };
    expect(describeCall(approve, done)).toBe(
      `Permitiste que el contrato de swap de la plataforma (${groupAddress(EXECUTOR)}) use exactamente 20,00 USDC de ` +
        'tu Safe, sólo para este swap',
    );
    const swap: DecodedCall = {
      kind: 'SWAP',
      tokenIn: 'USDC',
      tokenOut: 'USDT',
      amountIn: 20_000_000n,
      minAmountOut: 19_940_000n,
      deadline: 1n,
    };
    expect(describeCall(swap, done)).toBe(
      'Cambiaste 20,00 USDC por USDT (como mínimo 19,94 USDT), que llegaron a tu Safe',
    );
    expect(describeCall({ kind: 'WHITELIST_ADD', destination: A }, done)).toBe(
      `Agregaste a tu whitelist el destino «Cuenta de Ana» (${groupAddress(A)}) (se activa 24 h después de incluirse ` +
        'en un bloque)',
    );
    const pastTense: [DecodedCall, RegExp][] = [
      [{ kind: 'WHITELIST_REMOVE', destination: A }, /^Quitaste de tu whitelist/],
      [{ kind: 'NOOP' }, /anuló la operación pendiente que tenía/],
      [
        { kind: 'APPROVE', token: 'USDT', spender: A, amount: 0n, spenderIsSwapExecutor: false },
        /^Revocaste el permiso sobre tus USDT que tenía/,
      ],
      [{ kind: 'APPROVE', token: 'USDC', spender: A, amount: 1n, spenderIsSwapExecutor: false }, /de tu Safe$/],
      [{ kind: 'ROTATION_PROPOSE', role: 'R', oldValue: A, newValue: A }, /^Propusiste/],
      [{ kind: 'ROTATION_CANCEL', proposalId: `0x${'1'.repeat(64)}` }, /^Cancelaste/],
      [
        { kind: 'ROTATION_EXECUTE', prevOwner: A, oldOwner: A, newOwner: A },
        /^Se reemplazó en la Safe la dirección de la clave anterior .+ por la de la clave nueva /,
      ],
      [{ kind: 'GUARD_UPGRADE', target: 'GUARD', newGuard: Z }, /^Se quitó el Guard de seguridad de la Safe$/],
      [{ kind: 'GUARD_UPGRADE', target: 'MODULE_GUARD', newGuard: A }, /^Se cambió el guard de módulos a/],
      [
        { kind: 'GUARD_ROLES_UPDATE', userKey: A, recoveryKey: A, executor: A },
        /^Se registraron en el Guard las direcciones de las claves U /,
      ],
    ];
    for (const [call, text] of pastTense) expect(describeCall(call, done)).toMatch(text);
  });

  it('una clave o un contrato se nombran por su dirección, con el artículo de cada rol', () => {
    const Z2: Address = '0x00000000000000000000000000000000000000B2';
    expect(describeCall({ kind: 'ROTATION_PROPOSE', role: 'U', oldValue: A, newValue: Z2 })).toBe(
      `Proponer reemplazar la dirección de tu clave de usuario (U) ${groupAddress(A)} por ${groupAddress(Z2)} ` +
        '(se puede ejecutar a las 48 h y hasta entonces cancelar)',
    );
    expect(describeCall({ kind: 'ROTATION_PROPOSE', role: 'GUARD', oldValue: A, newValue: Z2 })).toMatch(
      /^Proponer reemplazar la dirección del Guard de seguridad 0x /,
    );
    expect(
      describeCall({ kind: 'ROTATION_PROPOSE', role: 'MODULE_GUARD', oldValue: A, newValue: Z2 }, { done: true }),
    ).toMatch(/^Propusiste reemplazar la dirección del guard de módulos 0x /);
    expect(describeCall({ kind: 'ROTATION_EXECUTE', prevOwner: A, oldOwner: A, newOwner: Z2 })).toBe(
      `Reemplazar en la Safe la dirección de la clave actual ${groupAddress(A)} por la de la clave nueva ${groupAddress(Z2)}`,
    );
  });

  it('roles: «tu» sólo para las claves del usuario; uno que la app no conoce, genérico (nunca el código)', () => {
    expect(roleText('U')).toBe('tu clave de usuario (U)');
    expect(roleText('R')).toBe('tu clave de recuperación (R)');
    expect(roleText('S')).toBe('la clave de la plataforma (S)');
    expect(ofRole('S')).toBe('de la clave de la plataforma (S)');
    expect(ofRole('GUARD')).toBe('del Guard de seguridad');
    expect(ofRole('MODULE_GUARD')).toBe('del guard de módulos');
    expect(ofRole('U')).toBe('de tu clave de usuario (U)');
    for (const raw of ['ROL_NUEVO', 'constructor', '__proto__', 'u', '', 7, null, undefined]) {
      expect(isRotationRole(raw)).toBe(false);
      expect(roleText(raw)).toBe(UNKNOWN_ROLE_TEXT);
    }
    expect(ofRole('ROL_NUEVO')).toBe(`de ${UNKNOWN_ROLE_TEXT}`);
    expect(UNKNOWN_ROLE_TEXT).not.toMatch(/ROL_NUEVO/);
  });

  it('un estado que esta app no conoce: texto genérico, nunca el código', () => {
    const unknown = {
      status: 'ESTADO_NUEVO',
      failureReason: null,
      lastErrorCode: null,
      history: [],
    } as unknown as OperationStatus;
    expect(stateLabel(unknown)).toBe(UNKNOWN_STATE_TEXT);
    expect(stateLabel({ ...unknown, status: 'toString' } as unknown as OperationStatus)).toBe(UNKNOWN_STATE_TEXT);
  });

  it('el permiso del swap nombra al contrato de swap de la plataforma (un label no lo tapa)', () => {
    const nameOf = addressNames({ system }, labelsOf([{ address: EXECUTOR, label: 'Otro nombre' }]));
    const text = describeCall(
      { kind: 'APPROVE', token: 'USDC', spender: EXECUTOR, amount: 20_000_000n, spenderIsSwapExecutor: true },
      { nameOf },
    );
    expect(text).toBe(
      `Permitir que el contrato de swap de la plataforma (${groupAddress(EXECUTOR)}) use exactamente 20,00 USDC de ` +
        'tu Safe, sólo para este swap (al ejecutarse el swap el permiso vuelve a 0)',
    );
  });

  it('nombres conocidos: tokens, el pool que usa la app y la propia Safe; una dirección desconocida no tiene nombre', () => {
    const nameOf = addressNames({ safe: SAFE, chain: pinnedChain, system });
    expect(nameOf(pinnedChain.tokens.usdc.address)).toBe('el contrato de USDC');
    expect(nameOf(pinnedChain.uniswap.pool.address)).toBe(POOL_NAME);
    expect(POOL_NAME).toBe('el pool USDC/USDT de Uniswap que usa la app');
    expect(nameOf(SAFE.toLowerCase() as Address)).toBe('tu Safe');
    expect(nameOf(A)).toBeNull();
  });

  it('vencimiento del swap: cuánto falta con la hora de la cadena, la hora con el reloj del dispositivo', () => {
    // En el fork la cadena va más de 24 h adelantada: el vencimiento no se muestra con la hora de la cadena.
    const deviceMs = Date.UTC(2026, 9, 19, 10, 24, 35);
    const chainMs = deviceMs + 25 * 3_600_000;
    const deadline = BigInt((chainMs + 10 * 60_000) / 1000);
    const at = new Date(deviceMs + 10 * 60_000).toLocaleTimeString('es-AR');
    expect(expiryText(deadline, { chainMs, deviceMs })).toBe(`vence en 10 min (${at})`);
    expect(expiryText(deadline, { chainMs: chainMs + 11 * 60_000, deviceMs })).toMatch(
      /^venció a las .*: volvé a cotizar$/,
    );
    expect(expiryText(deadline)).toMatch(/\(hora de la cadena\)$/);
    // Una vez ejecutado, el plazo ya no importa: el review no lo muestra.
    const swap: DecodedCall = {
      kind: 'SWAP',
      tokenIn: 'USDC',
      tokenOut: 'USDT',
      amountIn: 20_000_000n,
      minAmountOut: 19_940_000n,
      deadline,
    };
    expect(describeCall(swap, { clock: { chainMs, deviceMs }, showDeadline: false })).toBe(
      'Cambiar 20,00 USDC por al menos 19,94 USDT, que llegan a tu Safe',
    );
  });

  it('todos los estados del pipeline tienen texto, y los de la cadena su ayuda', () => {
    const states: OperationState[] = [
      'CREATED',
      'USER_SIGNED',
      'QUEUED',
      'VALIDATING',
      'READY',
      'SUBMITTED',
      'MINED',
      'CONFIRMED',
      'FINALIZED',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
      'REORGED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'EXPIRED',
    ];
    for (const state of states) expect(STATE_TEXT[state]).toMatch(/\S/);
    // La ayuda cubre todos los estados que se pueden ver, en el orden en que los recorre una operación.
    expect(STATE_HELP.map((h) => h.state)).toEqual(states);
    for (const help of STATE_HELP) expect(help.text).toMatch(/^[a-záéíóú].*\.$/);
  });

  it('cancelada antes de firmar y motivos en texto (sin códigos crudos)', () => {
    const status = (patch: Partial<OperationStatus>) =>
      ({ status: 'CANCELLED', failureReason: null, lastErrorCode: null, history: [], ...patch }) as OperationStatus;
    const unsigned = status({
      failureReason: 'USER_CANCELLED',
      history: [
        { status: 'CREATED', at: '2026-10-19T10:00:00Z' },
        { status: 'CANCELLED', at: '2026-10-19T10:01:00Z' },
      ],
    });
    expect(stateLabel(unsigned)).toBe('Cancelada antes de firmar');
    // El nombre del estado ya lo dice: no se repite como motivo.
    expect(operationReason(unsigned)).toBeNull();
    const byNoop = status({
      failureReason: 'SUPERSEDED_BY_NOOP',
      history: [
        { status: 'CREATED', at: '2026-10-19T10:00:00Z' },
        { status: 'USER_SIGNED', at: '2026-10-19T10:00:10Z' },
        { status: 'CANCELLED', at: '2026-10-19T10:05:00Z' },
      ],
    });
    expect(stateLabel(byNoop)).toBe('Cancelada');
    expect(operationReason(byNoop)).toBe('la reemplazó la operación vacía que firmaste para cancelarla');
    // Lo preparado que la plataforma descartó (nunca se firmó) también es "antes de firmar", con su motivo.
    const consumed = status({
      failureReason: 'NONCE_CONSUMED',
      history: [{ status: 'CREATED', at: '2026-10-19T10:00:00Z' }],
    });
    expect(stateLabel(consumed)).toBe('Cancelada antes de firmar');
    expect(operationReason(consumed)).toBe('otra operación ya usó su número de orden en tu Safe');
    // Sin historial (backend anterior) no se adivina.
    expect(stateLabel(status({}))).toBe('Cancelada');

    const failed = status({ status: 'FAILED_FINAL', failureReason: 'POLICY_REJECTED: DEADLINE_INVALID' });
    expect(stateLabel(failed)).toBe('Falló');
    expect(operationReason(failed)).toBe('no cumple las reglas de la plataforma: venció el plazo del swap');
    const retrying = status({ status: 'FAILED_RETRYABLE', failureReason: null, lastErrorCode: 'SIGNER_UNAVAILABLE' });
    expect(operationReason(retrying)).toBe('el servidor de firma de la plataforma no responde');
    // La mitad ya firmada de un swap cancelado antes de enviarse: el estado no lo dice, el motivo sí.
    const signedHalf = status({
      status: 'FAILED_FINAL',
      failureReason: 'USER_CANCELLED',
      lastErrorCode: 'USER_CANCELLED',
      history: [
        { status: 'CREATED', at: '2026-10-19T10:00:00Z' },
        { status: 'USER_SIGNED', at: '2026-10-19T10:00:10Z' },
      ],
    });
    expect(stateLabel(signedHalf)).toBe('Falló');
    expect(operationReason(signedHalf)).toBe('la cancelaste antes de que se enviara a la red');
    const expired = status({ status: 'EXPIRED', failureReason: 'NOT_SIGNED_IN_TIME' });
    expect(stateLabel(expired)).toBe('Venció sin firmar');
    expect(operationReason(expired)).toBeNull();
    // Una operación en la cadena no muestra motivos viejos.
    expect(operationReason(status({ status: 'MINED', failureReason: 'TX_DROPPED' }))).toBeNull();
  });

  it('plazo del swap con la hora de la cadena: la última lectura más lo que pasó, sin margen para firmar al final', () => {
    const clock = { chainMs: 1_800_000_000_000, deviceMs: 1_000_000 };
    expect(chainNowAt(clock)).toBe(clock.chainMs);
    expect(chainNowAt(clock, clock.deviceMs + 30_000)).toBe(clock.chainMs + 30_000);
    // Un reloj del dispositivo que va para atrás no resta.
    expect(chainNowAt(clock, clock.deviceMs - 5_000)).toBe(clock.chainMs);
    const deadline = BigInt((clock.chainMs + 10 * 60_000) / 1000);
    expect(deadlineRemainingMs(deadline, null)).toBeNull();
    expect(deadlineRemainingMs(deadline, clock, clock.deviceMs + 60_000)).toBe(9 * 60_000);
    expect(expiryText(deadline, clock, clock.deviceMs + 60_000)).toMatch(/^vence en 9 min \(/);
    const closing = clock.deviceMs + 10 * 60_000 - SWAP_SIGN_MARGIN_MS + 1_000;
    expect(expiryText(deadline, clock, closing)).toMatch(
      /^vence a las .*: ya no da tiempo a firmarlo, volvé a cotizar$/,
    );
    expect(expiryText(deadline, clock, clock.deviceMs + 10 * 60_000)).toMatch(/^venció a las .*: volvé a cotizar$/);
    const swap = (d: bigint): DecodedCall => ({
      kind: 'SWAP',
      tokenIn: 'USDC',
      tokenOut: 'USDT',
      amountIn: 1n,
      minAmountOut: 1n,
      deadline: d,
    });
    expect(swapDeadline([{ kind: 'NOOP' }])).toBeNull();
    expect(swapDeadline([{ kind: 'NOOP' }, swap(20n), swap(10n)])).toBe(10n);
  });

  it('contexto de decodificación de la Safe y nonce on-chain', async () => {
    const ctx = decodeContext(A);
    expect(ctx.safe).toBe(A);
    expect(ctx.chain).toBe(pinnedChain);
    const reader = { readContract: () => Promise.resolve(7n) } as never;
    expect(await onchainNonce(reader, A)).toBe(7n);
  });
});
