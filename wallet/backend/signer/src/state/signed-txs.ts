// SafeTx co-firmadas por el shard [B-SIG-03]: regla "a lo sumo una SafeTx activa por (safe, nonce)" salvo reemplazo
// explícito (NoOp o nueva firma del usuario que nombra la que reemplaza), ledger de salidas de 24 h y emparejamiento
// approve/swap. Las filas no se borran: pasan a CONSUMED (el nonce on-chain avanzó) o REPLACED.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Address } from '../crypto/keccak.ts';
import type { SignerDatabase } from './schema.ts';

type Db = Kysely<SignerDatabase> | Transaction<SignerDatabase>;

export interface SignedSafeTxRow {
  id: string;
  safeTxHash: string;
  opType: string;
  nonce: bigint;
  status: 'ACTIVE' | 'REPLACED' | 'CONSUMED';
  pairedSafeTxHash: string | null;
}

export class SignedSafeTxStore {
  readonly db: Kysely<SignerDatabase>;

  constructor(db: Kysely<SignerDatabase>) {
    this.db = db;
  }

  /** Serializa las co-firmas de una Safe (ledger y regla de nonce) dentro de la transacción. */
  async lockSafe(trx: Transaction<SignerDatabase>, safe: Address): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`signer:safe:${safe.toLowerCase()}`}, 0))`.execute(trx);
  }

  /** Las filas activas con nonce menor al on-chain ya no pueden ejecutarse: CONSUMED. */
  async markConsumed(db: Db, safe: Address, onchainNonce: bigint): Promise<void> {
    await db
      .updateTable('signed_safe_txs')
      .set({ status: 'CONSUMED' })
      .where('safe', '=', safe.toLowerCase())
      .where('status', '=', 'ACTIVE')
      .where('nonce', '<', onchainNonce.toString())
      .execute();
  }

  async activeAt(db: Db, safe: Address, nonce: bigint): Promise<SignedSafeTxRow | undefined> {
    const row = await db
      .selectFrom('signed_safe_txs')
      .select(['id', 'safe_tx_hash', 'op_type', 'nonce', 'status', 'paired_safe_tx_hash'])
      .where('safe', '=', safe.toLowerCase())
      .where('nonce', '=', nonce.toString())
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row && toRow(row);
  }

  async byHash(db: Db, safeTxHash: string): Promise<SignedSafeTxRow | undefined> {
    const row = await db
      .selectFrom('signed_safe_txs')
      .select(['id', 'safe_tx_hash', 'op_type', 'nonce', 'status', 'paired_safe_tx_hash'])
      .where('safe_tx_hash', '=', safeTxHash.toLowerCase())
      .executeTakeFirst();
    return row && toRow(row);
  }

  /**
   * Salida de SEND de las últimas 24 h: por cada nonce sólo una SafeTx puede ejecutarse, así que se suma el mayor
   * monto firmado de cada nonce (cota exacta, también con reemplazos). `atNonce` devuelve el mayor monto ya firmado
   * en el nonce de la operación actual (sin contar la misma SafeTx).
   */
  async dailyOutflow(
    db: Db,
    safe: Address,
    nonce: bigint,
    excludeHash: string,
  ): Promise<{ others: bigint; atNonce: bigint }> {
    const rows = await db
      .selectFrom('signed_safe_txs')
      .select(['nonce', sql<string>`max(amount)`.as('max_amount')])
      .where('safe', '=', safe.toLowerCase())
      .where('op_type', '=', 'SEND')
      .where('safe_tx_hash', '<>', excludeHash.toLowerCase())
      .where(sql<boolean>`signed_at > now() - interval '24 hours'`)
      .groupBy('nonce')
      .execute();
    let others = 0n;
    let atNonce = 0n;
    for (const row of rows) {
      const amount = BigInt(row.max_amount);
      if (BigInt(row.nonce) === nonce) atNonce = amount;
      else others += amount;
    }
    return { others, atNonce };
  }

  /** SWAP: el SWAP_APPROVE N−1 co-firmado por este shard y emparejado con esta SafeTx. */
  async approvalPairedWith(db: Db, safe: Address, approveNonce: bigint, swapHash: string): Promise<boolean> {
    const row = await db
      .selectFrom('signed_safe_txs')
      .select('id')
      .where('safe', '=', safe.toLowerCase())
      .where('nonce', '=', approveNonce.toString())
      .where('op_type', '=', 'SWAP_APPROVE')
      .where('paired_safe_tx_hash', '=', swapHash.toLowerCase())
      .where('status', 'in', ['ACTIVE', 'CONSUMED'])
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Alta (o re-firma de la misma SafeTx) + reemplazo explícito + firma de execTransaction, en la transacción. */
  async record(
    trx: Transaction<SignerDatabase>,
    input: {
      safe: Address;
      walletId: string;
      nonce: bigint;
      safeTxHash: string;
      operationId: string;
      opType: string;
      ownerRole: 'U' | 'R';
      token: Address | null;
      amount: bigint | null;
      destination: Address | null;
      pairedSafeTxHash: string | null;
      executor: Address;
      submittedAt: Date;
      replaces: string | null;
      exec: {
        accountNonce: bigint;
        txHash: string;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
        gasLimit: bigint;
      };
    },
  ): Promise<void> {
    if (input.replaces !== null) {
      // El reemplazo se marca antes de dar de alta la nueva (el índice parcial admite una sola activa).
      await trx.updateTable('signed_safe_txs').set({ status: 'REPLACED' }).where('id', '=', input.replaces).execute();
    }
    const existing = await this.byHash(trx, input.safeTxHash);
    let id: string;
    if (existing === undefined) {
      const row = await trx
        .insertInto('signed_safe_txs')
        .values({
          safe: input.safe.toLowerCase(),
          wallet_id: input.walletId,
          nonce: input.nonce.toString(),
          safe_tx_hash: input.safeTxHash.toLowerCase(),
          operation_id: input.operationId,
          op_type: input.opType,
          owner_role: input.ownerRole,
          token: input.token?.toLowerCase() ?? null,
          amount: input.amount?.toString() ?? null,
          destination: input.destination?.toLowerCase() ?? null,
          paired_safe_tx_hash: input.pairedSafeTxHash?.toLowerCase() ?? null,
          status: 'ACTIVE',
          executor: input.executor.toLowerCase(),
          submitted_at: input.submittedAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    } else {
      id = existing.id;
    }
    if (input.replaces !== null) {
      await trx.updateTable('signed_safe_txs').set({ replaced_by: id }).where('id', '=', input.replaces).execute();
    }
    await trx
      .insertInto('exec_signatures')
      .values({
        signed_safe_tx_id: id,
        account_nonce: input.exec.accountNonce.toString(),
        tx_hash: input.exec.txHash.toLowerCase(),
        max_fee_per_gas: input.exec.maxFeePerGas.toString(),
        max_priority_fee_per_gas: input.exec.maxPriorityFeePerGas.toString(),
        gas_limit: input.exec.gasLimit.toString(),
      })
      .onConflict((oc) => oc.column('tx_hash').doNothing())
      .execute();
  }
}

function toRow(row: {
  id: string;
  safe_tx_hash: string;
  op_type: string;
  nonce: string;
  status: 'ACTIVE' | 'REPLACED' | 'CONSUMED';
  paired_safe_tx_hash: string | null;
}): SignedSafeTxRow {
  return {
    id: row.id,
    safeTxHash: row.safe_tx_hash,
    opType: row.op_type,
    nonce: BigInt(row.nonce),
    status: row.status,
    pairedSafeTxHash: row.paired_safe_tx_hash,
  };
}
