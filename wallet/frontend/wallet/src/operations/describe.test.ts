// Review de P18: cada tipo de operación decodificada tiene su texto (montos es-AR y direcciones agrupadas), lo no
// reconocido se anuncia como no firmable, y todos los estados del pipeline tienen texto. P18.MAN: el destino aparece con
// su nombre (label de la whitelist o contrato del sistema) y la dirección completa al lado; el permiso del swap nombra al
// contrato de swap de la plataforma; el vencimiento del swap se mide con la hora de la cadena y se muestra en la del
// dispositivo.
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { OperationState } from '../api/wallet-api.ts';
import type { DecodedCall } from '../chain/decoders.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { decodeContext, onchainNonce } from './context.ts';
import { describeCall, describeParts, expiryText, partsText, SETTLEMENT_HELP, STATE_TEXT } from './describe.ts';
import { addressNames, labelsOf, POOL_NAME } from './names.ts';

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
      /Proponer reemplazar la clave de la plataforma \(S\)/,
    ],
    [{ kind: 'ROTATION_CANCEL', proposalId: `0x${'1'.repeat(64)}` }, /Cancelar la propuesta/],
    [{ kind: 'ROTATION_EXECUTE', prevOwner: A, oldOwner: A, newOwner: A }, /Reemplazar en la Safe/],
    [{ kind: 'GUARD_UPGRADE', target: 'GUARD', newGuard: Z }, /Quitar el Guard de seguridad/],
    [{ kind: 'GUARD_UPGRADE', target: 'MODULE_GUARD', newGuard: A }, /Cambiar el guard de módulos a/],
    [{ kind: 'GUARD_ROLES_UPDATE', userKey: A, recoveryKey: A, executor: A }, /Registrar en el Guard/],
    [{ kind: 'UNKNOWN', reason: 'DELEGATECALL' }, /no se firma/],
  ])('texto de %#', (call, text) => {
    expect(describeCall(call)).toMatch(text);
  });

  it('el destino con su nombre de la whitelist y la dirección completa; monto y token como parte destacada', () => {
    const nameOf = addressNames({ safe: SAFE, system }, labelsOf([{ address: A, label: 'Cuenta de Ana' }]));
    const call: DecodedCall = { kind: 'TRANSFER', token: 'USDC', recipient: A, amount: 1_500_000n };
    const parts = describeParts(call, { nameOf });
    expect(parts).toEqual([
      { kind: 'text', text: 'Enviar ' },
      { kind: 'amount', text: '1,50 USDC' },
      { kind: 'text', text: ' a ' },
      { kind: 'address', address: A, name: 'Cuenta de Ana' },
    ]);
    expect(partsText(parts)).toBe(`Enviar 1,50 USDC a Cuenta de Ana (${groupAddress(A)})`);
    expect(describeCall({ kind: 'WHITELIST_ADD', destination: A }, { nameOf })).toBe(
      `Agregar a tu whitelist el destino Cuenta de Ana (${groupAddress(A)}) (se activa 24 h después)`,
    );
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

  it('nombres conocidos: tokens, pool fijado y la propia Safe; una dirección desconocida no tiene nombre', () => {
    const nameOf = addressNames({ safe: SAFE, chain: pinnedChain, system });
    expect(nameOf(pinnedChain.tokens.usdc.address)).toBe('el contrato de USDC');
    expect(nameOf(pinnedChain.uniswap.pool.address)).toBe(POOL_NAME);
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
    expect(SETTLEMENT_HELP.map((h) => h.state)).toEqual(['MINED', 'CONFIRMED', 'FINALIZED']);
  });

  it('contexto de decodificación de la Safe y nonce on-chain', async () => {
    const ctx = decodeContext(A);
    expect(ctx.safe).toBe(A);
    expect(ctx.chain).toBe(pinnedChain);
    const reader = { readContract: () => Promise.resolve(7n) } as never;
    expect(await onchainNonce(reader, A)).toBe(7n);
  });
});
