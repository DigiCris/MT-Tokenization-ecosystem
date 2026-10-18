// Actividad (P18.T08): operaciones de la plataforma con su estado (incluidos MINED, CONFIRMED y FINALIZED) y los
// transfers entrantes y salientes indexados, en una sola lista ordenada por fecha, con link al explorer de la cadena
// (sólo un link: no se embebe nada de terceros).
import type { OperationStatus, Transfer } from '../api/wallet-api.ts';
import type { PinnedChain } from '../config/chain.ts';

export type ActivityItem =
  | {
      kind: 'operation';
      at: Date;
      operation: OperationStatus;
      /** Transfers salientes indexados de la transacción de la operación (monto, token y destino reales). */
      transfers: Transfer[];
    }
  | { kind: 'transfer'; at: Date; transfer: Transfer };

function sameTx(operation: OperationStatus, transfer: Transfer): boolean {
  return operation.txHash !== null && operation.txHash.toLowerCase() === transfer.txHash.toLowerCase();
}

/**
 * Una lista por fecha. Un transfer saliente que originó una operación de la plataforma se muestra dentro de esa
 * operación (no dos veces); los salientes que la plataforma no originó (p. ej. una ejecución soberana) y los entrantes
 * son ítems propios.
 */
export function mergeActivity(operations: readonly OperationStatus[], transfers: readonly Transfer[]): ActivityItem[] {
  const folded = (t: Transfer) => t.direction === 'OUT' && operations.some((o) => sameTx(o, t));
  const items: ActivityItem[] = [
    ...operations.map((operation) => ({
      kind: 'operation' as const,
      at: new Date(operation.createdAt),
      operation,
      transfers: transfers.filter((t) => t.direction === 'OUT' && sameTx(operation, t)),
    })),
    ...transfers
      .filter((t) => !folded(t))
      .map((transfer) => ({ kind: 'transfer' as const, at: new Date(transfer.createdAt), transfer })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function explorerTx(chain: Pick<PinnedChain, 'explorer'>, txHash: string): string {
  return `${chain.explorer.tx}${txHash}`;
}

export function explorerAddress(chain: Pick<PinnedChain, 'explorer'>, address: string): string {
  return `${chain.explorer.address}${address}`;
}
