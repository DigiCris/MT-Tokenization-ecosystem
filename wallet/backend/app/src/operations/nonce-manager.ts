// Nonce de la Safe [B-NONCE-01/02] (P13.T02). Todo bajo `SELECT … FROM wallets WHERE id = $1 FOR UPDATE` dentro de la
// transacción de `prepare` (o de la liberación): dos prepare concurrentes de la misma Safe se serializan en la fila.
//
// Asignación: el menor nonce n ≥ max(nonce on-chain (quórum), mayor nonce ya ejecutado + 1) que no use ninguna
// operación viva (CREATED vigente o cualquier estado del índice único de nonces activos, más CANCEL_REQUESTED, cuyo
// nonce queda reservado para su NoOp). Sin huecos es exactamente `max(onchainNonce, next_safe_nonce, max(activo)+1)`;
// con huecos (una CREATED que venció, una cancelada antes de firmar o una FAILED_FINAL), el nonce liberado vuelve a
// estar disponible ([B-NONCE-02]) y la próxima operación lo ocupa: si no, las de nonce mayor quedarían esperando para
// siempre un nonce menor que nadie va a usar. `next_safe_nonce` guarda el próximo nonce libre (se recalcula en cada
// asignación y liberación). El índice único parcial sigue impidiendo dos operaciones activas con el mismo nonce.
import { sql, type Transaction } from 'kysely';
import type { Database, OperationStatus, WalletRow } from '../db/schema.ts';

/** Estados que ocupan su nonce (índice único parcial + CANCEL_REQUESTED, reservado para la NoOp). */
export const NONCE_HOLDING_STATUSES: readonly OperationStatus[] = [
  'USER_SIGNED',
  'QUEUED',
  'VALIDATING',
  'READY',
  'SUBMITTED',
  'MINED',
  'FAILED_RETRYABLE',
  'REORGED',
  'CONFIRMED',
  'FINALIZED',
  'CANCEL_REQUESTED',
];

/** Ya ejecutadas on-chain (su nonce está consumido salvo reorg). */
const EXECUTED_STATUSES: readonly OperationStatus[] = ['MINED', 'CONFIRMED', 'FINALIZED'];

export class WalletNotFoundError extends Error {
  override name = 'WalletNotFoundError';
}

/** Bloquea la fila de la wallet hasta el fin de la transacción (serializa nonces y estado de la Safe). */
export async function lockWallet(trx: Transaction<Database>, walletId: string): Promise<WalletRow> {
  const wallet = await trx.selectFrom('wallets').selectAll().where('id', '=', walletId).forUpdate().executeTakeFirst();
  if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} inexistente`);
  return wallet;
}

async function usedNonces(trx: Transaction<Database>, walletId: string, from: bigint): Promise<Set<bigint>> {
  const rows = await trx
    .selectFrom('wallet_operations')
    .select('safe_nonce')
    .where('wallet_id', '=', walletId)
    .where('safe_nonce', '>=', from.toString())
    .where((eb) =>
      eb.or([
        eb('status', 'in', NONCE_HOLDING_STATUSES),
        eb.and([eb('status', '=', 'CREATED'), eb('expires_at', '>', sql<Date>`now()`)]),
      ]),
    )
    .execute();
  return new Set(rows.map((r) => BigInt(r.safe_nonce)));
}

async function executedFloor(trx: Transaction<Database>, walletId: string): Promise<bigint> {
  const row = await trx
    .selectFrom('wallet_operations')
    .select(sql<string | null>`max(safe_nonce)`.as('max'))
    .where('wallet_id', '=', walletId)
    .where('status', 'in', EXECUTED_STATUSES)
    .executeTakeFirstOrThrow();
  return row.max === null ? 0n : BigInt(row.max) + 1n;
}

function firstFree(used: Set<bigint>, from: bigint): bigint {
  let n = from;
  while (used.has(n)) n++;
  return n;
}

/**
 * Asigna el nonce de una operación nueva. La fila de la wallet tiene que estar bloqueada (lockWallet) en la misma
 * transacción, que inserta la operación con el nonce devuelto.
 */
export async function allocateNonce(
  trx: Transaction<Database>,
  walletId: string,
  onchainNonce: bigint,
): Promise<bigint> {
  const floorExecuted = await executedFloor(trx, walletId);
  const from = onchainNonce > floorExecuted ? onchainNonce : floorExecuted;
  const used = await usedNonces(trx, walletId, from);
  const nonce = firstFree(used, from);
  used.add(nonce);
  await trx
    .updateTable('wallets')
    .set({ next_safe_nonce: firstFree(used, from).toString() })
    .where('id', '=', walletId)
    .execute();
  return nonce;
}

/**
 * Recalcula `next_safe_nonce` después de liberar un nonce (CREATED vencida o cancelada, FAILED_FINAL, CANCELLED):
 * el menor libre desde el último nonce conocido como ejecutado. Requiere la fila de la wallet bloqueada.
 */
export async function refreshNextNonce(trx: Transaction<Database>, walletId: string): Promise<bigint> {
  const from = await executedFloor(trx, walletId);
  const next = firstFree(await usedNonces(trx, walletId, from), from);
  await trx.updateTable('wallets').set({ next_safe_nonce: next.toString() }).where('id', '=', walletId).execute();
  return next;
}
