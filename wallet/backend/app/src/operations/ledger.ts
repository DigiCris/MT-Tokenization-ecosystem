// Ledger de salidas de 24 h por Safe [B-POL-05] en Postgres: SEND firmados por U en las últimas 24 h que todavía
// pueden ejecutarse o ya se ejecutaron (no los vencidos, cancelados ni los FAILED_FINAL que S nunca co-firmó). Por
// cada nonce sólo una SafeTx puede ejecutarse, así que se suma el mayor monto de cada nonce; en el nonce de la
// operación evaluada cuenta el mayor entre lo ya firmado ahí y ella misma (la misma regla que aplica el signer).
import { sql, type Kysely } from 'kysely';
import type { Database, OperationStatus } from '../db/schema.ts';

const COUNTED: readonly OperationStatus[] = [
  'USER_SIGNED',
  'QUEUED',
  'VALIDATING',
  'READY',
  'SUBMITTED',
  'MINED',
  'CONFIRMED',
  'FINALIZED',
  'FAILED_RETRYABLE',
  'REORGED',
  'CANCEL_REQUESTED',
];

/**
 * Salida ya usada sin contar la operación evaluada: `others + max(atNonce − amount, 0)`, de modo que la policy sume
 * `amount` y compare con el tope diario.
 */
export async function dailyOutflow(
  db: Kysely<Database>,
  input: { walletId: string; nonce: bigint; excludeOperationId: string | null; amount?: bigint },
): Promise<bigint> {
  let query = db
    .selectFrom('wallet_operations')
    .select(['safe_nonce', sql<string>`max((canonical_intent -> 'decoded' ->> 'amount')::numeric)`.as('max_amount')])
    .where('wallet_id', '=', input.walletId)
    .where('operation_type', '=', 'SEND')
    .where('signed_at', '>', sql<Date>`now() - interval '24 hours'`)
    .where((eb) =>
      eb.or([
        eb('status', 'in', COUNTED),
        eb.and([eb('status', '=', 'FAILED_FINAL'), eb('s_signature', 'is not', null)]),
      ]),
    )
    .groupBy('safe_nonce');
  if (input.excludeOperationId !== null) query = query.where('id', '<>', input.excludeOperationId);
  const rows = await query.execute();
  let others = 0n;
  let atNonce = 0n;
  for (const row of rows) {
    const amount = BigInt(row.max_amount);
    if (BigInt(row.safe_nonce) === input.nonce) atNonce = amount;
    else others += amount;
  }
  const amount = input.amount ?? 0n;
  return others + (atNonce > amount ? atNonce - amount : 0n);
}
