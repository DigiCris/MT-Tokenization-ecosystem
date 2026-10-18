// P18.T08: operaciones y transfers en una lista por fecha, sin duplicar el transfer saliente de una operación propia, y
// links al explorer fijado.
import { describe, expect, it } from 'vitest';
import type { OperationStatus, Transfer } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import { explorerAddress, explorerTx, mergeActivity } from './activity.ts';

const op = (id: string, createdAt: string, txHash: string | null) =>
  ({ id, createdAt, txHash, status: 'FINALIZED', operationType: 'SEND' }) as OperationStatus;
const transfer = (id: string, createdAt: string, direction: 'IN' | 'OUT', txHash: string) =>
  ({ id, createdAt, direction, txHash, token: 'USDC', amount: '1' }) as Transfer;

describe('actividad', () => {
  it('ordena por fecha y muestra el transfer saliente de una operación propia dentro de ella, no dos veces', () => {
    const items = mergeActivity(
      [op('o1', '2026-10-18T10:00:00Z', `0x${'aa'.repeat(32)}`), op('o2', '2026-10-18T12:00:00Z', null)],
      [
        transfer('t1', '2026-10-18T10:00:05Z', 'OUT', `0x${'AA'.repeat(32)}`),
        transfer('t2', '2026-10-18T11:00:00Z', 'IN', `0x${'bb'.repeat(32)}`),
        transfer('t3', '2026-10-18T09:00:00Z', 'OUT', `0x${'cc'.repeat(32)}`),
      ],
    );
    expect(items.map((i) => (i.kind === 'operation' ? i.operation.id : i.transfer.id))).toEqual([
      'o2',
      't2',
      'o1',
      't3',
    ]);
    const send = items.find((i) => i.kind === 'operation' && i.operation.id === 'o1');
    expect(send?.kind === 'operation' ? send.transfers.map((t) => t.id) : null).toEqual(['t1']);
    const pending = items.find((i) => i.kind === 'operation' && i.operation.id === 'o2');
    expect(pending?.kind === 'operation' ? pending.transfers : null).toEqual([]);
  });

  it('un saliente de la misma tx que una operación pero entrante no se pliega', () => {
    const tx = `0x${'dd'.repeat(32)}`;
    const items = mergeActivity(
      [op('o1', '2026-10-18T10:00:00Z', tx)],
      [transfer('t1', '2026-10-18T10:00:01Z', 'IN', tx)],
    );
    expect(items.map((i) => i.kind)).toEqual(['transfer', 'operation']);
  });

  it('links al explorer fijado', () => {
    expect(explorerTx(pinnedChain, '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerAddress(pinnedChain, '0xdef')).toBe('https://basescan.org/address/0xdef');
  });
});
