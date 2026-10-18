// Watcher de finalidad y reorgs [B-FIN-01/02] (P13.T06), cada bloque/2 s. Para toda operación MINED o CONFIRMED vuelve
// a leer el receipt con quórum: si desapareció o cambió el hash de su bloque → REORGED (alerta); si sigue en el mismo
// bloque avanza según CONFIRMATION_POLICY (ADR-018): `tags` → CONFIRMED con bloque ≤ head `safe`, FINALIZED con bloque
// ≤ head `finalized` (heads conservadores: el mínimo de los proveedores); `depth` (local/fork) → por profundidad.
//
// Una REORGED se resuelve sin intervención: si la misma tx de S volvió a incluirse → MINED con el bloque nuevo; si
// sigue en el mempool → espera; si desapareció → QUEUED para revalidar y retransmitir la MISMA SafeTx. También cierra la
// carrera de una cancelación cuando la original se mina sin que el worker la esté esperando ([B-NONCE-06]). Una
// inconsistencia entre RPCs no transiciona nada: se reintenta en la próxima pasada [B-FIN-02].
import { sql, type Kysely, type Selectable } from 'kysely';
import type { TransactionReceipt } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { ChainTransactionsTable, Database, OperationStatus, WalletOperationsTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { bufferToHex, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { TransitionConflictError, type OperationStateMachine } from '../operations/state-machine.ts';
import { RpcQuorumError, type RpcQuorumClient } from './rpc-quorum.ts';

type OperationRow = Selectable<WalletOperationsTable>;
type ChainTxRow = Selectable<ChainTransactionsTable>;

export interface ConfirmationPolicy {
  policy: 'depth' | 'tags';
  confirmationDepth: number;
  finalizationDepth: number;
}

export interface WatcherDeps {
  db: Kysely<Database>;
  machine: OperationStateMachine;
  audit: AuditWriter;
  rpc: RpcQuorumClient;
  confirmations: ConfirmationPolicy;
  logger: Logger;
  metrics: Metrics;
  actorId?: string;
}

export interface WatcherResult {
  confirmed: number;
  finalized: number;
  reorged: number;
  remined: number;
  requeued: number;
  cancellationsLost: number;
}

const NOOP_OPEN: readonly OperationStatus[] = [
  'CREATED',
  'QUEUED',
  'FAILED_RETRYABLE',
  'VALIDATING',
  'READY',
  'SUBMITTED',
];

export class FinalityWatcher {
  readonly #d: WatcherDeps;
  readonly #actor: { type: 'WORKER'; id: string };

  constructor(deps: WatcherDeps) {
    this.#d = deps;
    this.#actor = { type: 'WORKER', id: deps.actorId ?? 'finality-watcher' };
  }

  async runOnce(): Promise<WatcherResult> {
    const result: WatcherResult = {
      confirmed: 0,
      finalized: 0,
      reorged: 0,
      remined: 0,
      requeued: 0,
      cancellationsLost: 0,
    };
    let heads: { latest: bigint; safe: bigint; finalized: bigint };
    try {
      heads = await this.#heads();
    } catch (error) {
      if (!(error instanceof RpcQuorumError)) throw error;
      this.#d.logger.warn({ code: error.code }, 'heads sin quórum: el watcher no decide nada en esta pasada');
      return result;
    }
    const mined = await this.#d.db
      .selectFrom('wallet_operations')
      .selectAll()
      .where('status', 'in', ['MINED', 'CONFIRMED'])
      .orderBy('block_number', 'asc')
      .limit(500)
      .execute();
    for (const op of mined) await this.#guard(() => this.#checkMined(op, heads, result));
    const reorged = await this.#d.db
      .selectFrom('wallet_operations')
      .selectAll()
      .where('status', '=', 'REORGED')
      .limit(200)
      .execute();
    for (const op of reorged) await this.#guard(() => this.#resolveReorged(op, result));
    const cancelling = await this.#d.db
      .selectFrom('wallet_operations')
      .selectAll()
      .where('status', '=', 'CANCEL_REQUESTED')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('chain_transactions')
            .select('id')
            .whereRef('chain_transactions.operation_id', '=', 'wallet_operations.id')
            .where('chain_transactions.status', '=', 'BROADCAST'),
        ),
      )
      .limit(200)
      .execute();
    for (const op of cancelling) await this.#guard(() => this.#checkCancellationRace(op, result));
    return result;
  }

  /** Errores de RPC o carreras con el worker: sin transición, se reintenta en la próxima pasada. */
  async #guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof RpcQuorumError) {
        this.#d.metrics.operationErrors.inc({ code: error.code });
        this.#d.logger.warn({ code: error.code }, 'lectura sin quórum en el watcher: se reintenta');
        return;
      }
      if (error instanceof TransitionConflictError) return;
      throw error;
    }
  }

  async #heads(): Promise<{ latest: bigint; safe: bigint; finalized: bigint }> {
    const latest = await this.#d.rpc.commonHead();
    if (this.#d.confirmations.policy === 'depth') return { latest, safe: latest, finalized: latest };
    const tags = await this.#d.rpc.headTags();
    return { latest, ...tags };
  }

  #levels(blockNumber: bigint, heads: { latest: bigint; safe: bigint; finalized: bigint }) {
    const c = this.#d.confirmations;
    if (c.policy === 'depth') {
      const depth = heads.latest - blockNumber + 1n;
      return { confirmed: depth >= BigInt(c.confirmationDepth), finalized: depth >= BigInt(c.finalizationDepth) };
    }
    return { confirmed: blockNumber <= heads.safe, finalized: blockNumber <= heads.finalized };
  }

  async #checkMined(
    op: OperationRow,
    heads: { latest: bigint; safe: bigint; finalized: bigint },
    result: WatcherResult,
  ): Promise<void> {
    if (op.tx_hash === null || op.block_hash === null || op.block_number === null) return;
    const receipt = await this.#d.rpc.getTransactionReceipt(bufferToHex(op.tx_hash));
    const storedHash = bufferToHex(op.block_hash);
    if (receipt?.status !== 'success' || receipt.blockHash.toLowerCase() !== storedHash) {
      await this.#reorg(op, receipt, result);
      return;
    }
    const levels = this.#levels(receipt.blockNumber, heads);
    let status = op.status;
    if (status === 'MINED' && levels.confirmed) {
      await withTransaction(
        this.#d.db,
        async (trx) => {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['MINED'],
            to: 'CONFIRMED',
            actor: this.#actor,
            patch: { confirmed_at: new Date() },
            detail: { blockNumber: receipt.blockNumber.toString(), blockHash: storedHash },
          });
          await this.#setTxStatus(trx, op.tx_hash, 'CONFIRMED');
        },
        { auditLock: true },
      );
      status = 'CONFIRMED';
      result.confirmed++;
      this.#d.metrics.operationTransitions.inc({ to: 'CONFIRMED' });
      this.#d.metrics.executorTransactions.inc({ result: 'confirmed' });
    }
    if (status === 'CONFIRMED' && levels.finalized) {
      await withTransaction(
        this.#d.db,
        async (trx) => {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['CONFIRMED'],
            to: 'FINALIZED',
            actor: this.#actor,
            patch: { finalized_at: new Date() },
            detail: { blockNumber: receipt.blockNumber.toString(), blockHash: storedHash },
          });
          await this.#setTxStatus(trx, op.tx_hash, 'FINALIZED');
        },
        { auditLock: true },
      );
      result.finalized++;
      this.#d.metrics.operationTransitions.inc({ to: 'FINALIZED' });
      this.#d.metrics.executorTransactions.inc({ result: 'finalized' });
    }
  }

  async #setTxStatus(
    trx: Parameters<Parameters<typeof withTransaction<Database, unknown>>[1]>[0],
    txHash: Buffer | null,
    status: ChainTxRow['status'],
  ): Promise<void> {
    if (txHash === null) return;
    await trx
      .updateTable('chain_transactions')
      .set({ status, updated_at: sql`now()` })
      .where('tx_hash', '=', txHash)
      .execute();
  }

  /** MINED/CONFIRMED cuyo receipt desapareció o cambió de bloque: REORGED + alerta (REORG_DETECTED). */
  async #reorg(op: OperationRow, receipt: TransactionReceipt | null, result: WatcherResult): Promise<void> {
    const detail = {
      oldBlockNumber: op.block_number,
      oldBlockHash: op.block_hash === null ? null : bufferToHex(op.block_hash),
      newBlockNumber: receipt?.blockNumber.toString() ?? null,
      newBlockHash: receipt?.blockHash ?? null,
      txHash: op.tx_hash === null ? null : bufferToHex(op.tx_hash),
    };
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#d.machine.transitionIn(trx, {
          operationId: op.id,
          from: [op.status],
          to: 'REORGED',
          actor: this.#actor,
          patch: { block_number: null, block_hash: null, confirmed_at: null },
          detail,
        });
        await this.#setTxStatus(trx, op.tx_hash, 'REORGED');
        await this.#d.audit.append(trx, {
          actorType: 'WORKER',
          actorId: this.#actor.id,
          userId: op.user_id,
          walletId: op.wallet_id,
          eventType: 'REORG_DETECTED',
          targetType: 'operation',
          targetId: op.id,
          payload: detail,
        });
      },
      { auditLock: true },
    );
    result.reorged++;
    this.#d.metrics.reorgsDetected.inc({ kind: 'operation' });
    this.#d.metrics.operationTransitions.inc({ to: 'REORGED' });
    this.#d.metrics.executorTransactions.inc({ result: 'reorged' });
    this.#d.logger.error({ alert: 'REORG_DETECTED', operationId: op.id, ...detail }, 'reorg de una operación minada');
  }

  /** REORGED: re-incluida → MINED; en el mempool → espera; desaparecida → QUEUED (la misma SafeTx otra vez). */
  async #resolveReorged(op: OperationRow, result: WatcherResult): Promise<void> {
    const txs = await this.#d.db
      .selectFrom('chain_transactions')
      .selectAll()
      .where('operation_id', '=', op.id)
      .where('status', 'in', ['REORGED', 'MINED', 'BROADCAST', 'REPLACED'])
      .orderBy('created_at', 'desc')
      .execute();
    // Primero el mempool y después los receipts: una tx que se mina entre las dos lecturas aparece en la segunda (al
    // revés, se confundiría con una desaparecida y se re-ejecutaría una SafeTx ya ejecutada).
    let pending = false;
    for (const tx of txs) {
      if (await this.#d.rpc.isPending(bufferToHex(tx.tx_hash))) pending = true;
    }
    for (const tx of txs) {
      const receipt = await this.#d.rpc.getTransactionReceipt(bufferToHex(tx.tx_hash));
      if (receipt?.status !== 'success') continue;
      await withTransaction(
        this.#d.db,
        async (trx) => {
          await trx
            .updateTable('chain_transactions')
            .set({
              status: 'MINED',
              block_number: receipt.blockNumber.toString(),
              block_hash: hexToBuffer(receipt.blockHash, 32),
              receipt_status: 1,
              gas_used: receipt.gasUsed.toString(),
              effective_gas_price: receipt.effectiveGasPrice.toString(),
              updated_at: sql`now()`,
            })
            .where('id', '=', tx.id)
            .execute();
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['REORGED'],
            to: 'MINED',
            actor: this.#actor,
            patch: {
              tx_hash: tx.tx_hash,
              block_number: receipt.blockNumber.toString(),
              block_hash: hexToBuffer(receipt.blockHash, 32),
              mined_at: new Date(),
            },
            detail: { reincluded: true, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash },
          });
        },
        { auditLock: true },
      );
      result.remined++;
      this.#d.metrics.operationTransitions.inc({ to: 'MINED' });
      return;
    }
    if (pending) return;
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await trx
          .updateTable('chain_transactions')
          .set({ status: 'DROPPED', updated_at: sql`now()` })
          .where('operation_id', '=', op.id)
          .where('status', 'in', ['REORGED', 'BROADCAST'])
          .execute();
        await this.#d.machine.transitionIn(trx, {
          operationId: op.id,
          from: ['REORGED'],
          to: 'QUEUED',
          actor: this.#actor,
          patch: { tx_hash: null, submitted_at: null, mined_at: null, executed_at: null },
          detail: { reason: 'REORG_REEXECUTE' },
          outbox: { eventType: 'OPERATION_QUEUED', payload: { operationId: op.id, walletId: op.wallet_id } },
        });
      },
      { auditLock: true },
    );
    result.requeued++;
    this.#d.metrics.operationTransitions.inc({ to: 'QUEUED' });
    this.#d.logger.warn({ operationId: op.id }, 'operación reorganizada: se vuelve a ejecutar la misma SafeTx');
  }

  /** La original de una cancelación se minó primero: original MINED y la NoOp termina ("demasiado tarde"). */
  async #checkCancellationRace(original: OperationRow, result: WatcherResult): Promise<void> {
    const txs = await this.#d.db
      .selectFrom('chain_transactions')
      .selectAll()
      .where('operation_id', '=', original.id)
      .where('status', '=', 'BROADCAST')
      .execute();
    for (const tx of txs) {
      const receipt = await this.#d.rpc.getTransactionReceipt(bufferToHex(tx.tx_hash));
      if (receipt === null) continue;
      if (receipt.status !== 'success') {
        await this.#d.db
          .updateTable('chain_transactions')
          .set({
            status: 'FAILED',
            receipt_status: 0,
            block_number: receipt.blockNumber.toString(),
            block_hash: hexToBuffer(receipt.blockHash, 32),
            gas_used: receipt.gasUsed.toString(),
            updated_at: sql`now()`,
          })
          .where('id', '=', tx.id)
          .execute();
        continue;
      }
      await withTransaction(
        this.#d.db,
        async (trx) => {
          const noops = await trx
            .selectFrom('wallet_operations')
            .select(['id', 'status'])
            .where('cancels_operation_id', '=', original.id)
            .where('status', 'in', NOOP_OPEN)
            .execute();
          for (const noop of noops) {
            await this.#d.machine.transitionIn(trx, {
              operationId: noop.id,
              from: [noop.status],
              to: noop.status === 'CREATED' ? 'CANCELLED' : 'FAILED_FINAL',
              actor: this.#actor,
              patch: { failure_reason: 'CANCEL_TOO_LATE', last_error_code: 'CANCEL_TOO_LATE', blocked_reason: null },
            });
          }
          await trx
            .updateTable('chain_transactions')
            .set({
              status: 'MINED',
              block_number: receipt.blockNumber.toString(),
              block_hash: hexToBuffer(receipt.blockHash, 32),
              receipt_status: 1,
              gas_used: receipt.gasUsed.toString(),
              effective_gas_price: receipt.effectiveGasPrice.toString(),
              updated_at: sql`now()`,
            })
            .where('id', '=', tx.id)
            .execute();
          await trx
            .updateTable('chain_transactions')
            .set({ status: 'REPLACED', updated_at: sql`now()` })
            .where('chain_id', '=', tx.chain_id)
            .where('from_address', '=', tx.from_address)
            .where('account_nonce', '=', tx.account_nonce)
            .where('id', '<>', tx.id)
            .where('status', '=', 'BROADCAST')
            .execute();
          await this.#d.machine.transitionIn(trx, {
            operationId: original.id,
            from: ['CANCEL_REQUESTED'],
            to: 'MINED',
            actor: this.#actor,
            patch: {
              tx_hash: tx.tx_hash,
              block_number: receipt.blockNumber.toString(),
              block_hash: hexToBuffer(receipt.blockHash, 32),
              mined_at: new Date(),
            },
            detail: { cancellationLost: true },
          });
        },
        { auditLock: true },
      );
      result.cancellationsLost++;
      this.#d.metrics.operationTransitions.inc({ to: 'MINED' });
      return;
    }
  }
}
