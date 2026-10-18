// Review de P18: cada tipo de operación decodificada tiene su texto (montos es-AR y direcciones agrupadas), lo no
// reconocido se anuncia como no firmable, y todos los estados del pipeline tienen texto.
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { OperationState } from '../api/wallet-api.ts';
import type { DecodedCall } from '../chain/decoders.ts';
import { pinnedChain } from '../config/chain.ts';
import { decodeContext, onchainNonce } from './context.ts';
import { describeCall, STATE_TEXT } from './describe.ts';

// La config embebida del build (módulo virtual de Vite) no existe en Vitest: se reemplaza por una mínima.
vi.mock('../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: { contracts: {}, signerAttestationPublicKey: '' },
}));

const A: Address = '0x000000000000000000000000000000000000dEaD';
const Z: Address = '0x0000000000000000000000000000000000000000';

describe('texto de las operaciones', () => {
  it.each<[DecodedCall, RegExp]>([
    [{ kind: 'NOOP' }, /vacía/],
    [{ kind: 'TRANSFER', token: 'USDC', recipient: A, amount: 1_500_000n }, /Enviar 1,50 USDC a 0x 0000/],
    [{ kind: 'APPROVE', token: 'USDT', spender: A, amount: 0n }, /Revocar el permiso sobre USDT/],
    [{ kind: 'APPROVE', token: 'USDC', spender: A, amount: 2_000_000n }, /exactamente 2,00 USDC/],
    [
      {
        kind: 'SWAP',
        tokenIn: 'USDC',
        tokenOut: 'USDT',
        amountIn: 1_000_000n,
        minAmountOut: 990_000n,
        deadline: 1_792_189_000n,
      },
      /Cambiar 1,00 USDC por al menos 0,99 USDT/,
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

  it('todos los estados del pipeline tienen texto', () => {
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
  });

  it('contexto de decodificación de la Safe y nonce on-chain', async () => {
    const ctx = decodeContext(A);
    expect(ctx.safe).toBe(A);
    expect(ctx.chain).toBe(pinnedChain);
    const reader = { readContract: () => Promise.resolve(7n) } as never;
    expect(await onchainNonce(reader, A)).toBe(7n);
  });
});
