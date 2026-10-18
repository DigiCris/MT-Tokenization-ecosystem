// Coordinación de los grupos de swap en el worker (P14.T05):
//
// - Pares incompletos: si una mitad de un par sin encolar venció o se canceló, la otra se descarta (CREATED →
//   CANCELLED; USER_SIGNED sin co-firma de S → FAILED_FINAL `PAIR_INCOMPLETE`, nonce liberado).
// - Estado del grupo derivado de sus operaciones (operations/groups.ts); al quedar FAILED se notifica al usuario con
//   las acciones ofrecidas (re-cotizar o revocar la allowance).
// - Limpieza de allowances residuales: de cada grupo FAILED se lee con quórum la allowance on-chain del token de
//   entrada hacia el SwapExecutor y, si quedó > 0, se notifica una vez (RESIDUAL_ALLOWANCE).
import type { Kysely } from 'kysely';
import { type Abi } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { RpcQuorumError, type RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { discardUnqueuedPair, lockGroup, refreshGroupStatus } from '../operations/groups.ts';
import { lockWallet, refreshNextNonce } from '../operations/nonce-manager.ts';
import { DEAD_STATUSES } from '../operations/pairing.ts';
import type { OperationStateMachine } from '../operations/state-machine.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

const allowanceAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const ACTOR = { type: 'SYSTEM' as const, id: 'swap-coordinator' };

export interface SwapCoordinatorDeps {
  db: Kysely<Database>;
  machine: OperationStateMachine;
  audit: AuditWriter;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  logger: Logger;
  metrics?: Metrics;
}

export interface SwapCoordinatorResult {
  discarded: number;
  changed: number;
  residual: number;
}

export class SwapCoordinator {
  readonly #d: SwapCoordinatorDeps;

  constructor(deps: SwapCoordinatorDeps) {
    this.#d = deps;
  }

  async runOnce(): Promise<SwapCoordinatorResult> {
    const result: SwapCoordinatorResult = { discarded: 0, changed: 0, residual: 0 };
    const groups = await this.#d.db
      .selectFrom('operation_groups')
      .select(['id', 'wallet_id'])
      .where('status', 'in', ['OPEN', 'FAILED'])
      .orderBy('updated_at')
      .limit(200)
      .execute();
    for (const group of groups) {
      const outcome = await withTransaction(
        this.#d.db,
        async (trx) => {
          await lockWallet(trx, group.wallet_id);
          const locked = await lockGroup(trx, group.id);
          if (!locked) return { discarded: 0, changed: false };
          const ops = await trx
            .selectFrom('wallet_operations')
            .select(['id', 'operation_type', 'status', 'safe_nonce', 's_signature'])
            .where('group_id', '=', group.id)
            .execute();
          const live = (type: string, nonce: bigint) =>
            ops.some(
              (o) => o.operation_type === type && BigInt(o.safe_nonce) === nonce && !DEAD_STATUSES.includes(o.status),
            );
          const broken = ops.some((o) => {
            if (o.s_signature !== null || (o.status !== 'CREATED' && o.status !== 'USER_SIGNED')) return false;
            if (o.operation_type === 'SWAP_APPROVE') return !live('SWAP', BigInt(o.safe_nonce) + 1n);
            if (o.operation_type === 'SWAP') return !live('SWAP_APPROVE', BigInt(o.safe_nonce) - 1n);
            return false;
          });
          let discarded = 0;
          if (broken) {
            const changed = await discardUnqueuedPair(trx, this.#d.machine, group.id, {
              actor: ACTOR,
              reason: 'PAIR_INCOMPLETE',
            });
            for (const to of changed) this.#d.metrics?.operationTransitions.inc({ to });
            discarded = changed.length;
            await refreshNextNonce(trx, group.wallet_id);
          }
          const transition = await refreshGroupStatus(trx, this.#d.audit, group.id, ACTOR);
          if (transition?.to === 'FAILED') {
            const failed = await trx
              .selectFrom('operation_groups')
              .select(['failure_reason', 'updated_at'])
              .where('id', '=', group.id)
              .executeTakeFirstOrThrow();
            await notify(
              trx,
              {
                userId: locked.user_id,
                walletId: locked.wallet_id,
                type: 'SWAP_FAILED',
                payload: {
                  groupId: group.id,
                  failureReason: failed.failure_reason,
                  nextActions: ['REQUOTE', 'REVOKE_APPROVAL'],
                },
                dedupeKey: `SWAP_FAILED:${group.id}:${failed.updated_at.toISOString()}`,
              },
              this.#d.metrics,
            );
          }
          return { discarded, changed: transition !== null };
        },
        { auditLock: true },
      );
      result.discarded += outcome.discarded;
      if (outcome.changed) result.changed++;
    }
    try {
      result.residual = await this.#residualAllowances();
    } catch (error) {
      if (!(error instanceof RpcQuorumError)) throw error;
      this.#d.logger.warn({ code: error.code }, 'allowances residuales sin quórum: se reintenta en la próxima pasada');
    }
    return result;
  }

  /** Grupos FAILED sin revisar: allowance on-chain > 0 → notificación única; = 0 → nada que limpiar. */
  async #residualAllowances(): Promise<number> {
    const executor = this.#d.snapshot().contracts.swapExecutor;
    const groups = await this.#d.db
      .selectFrom('operation_groups as g')
      .innerJoin('wallets as w', 'w.id', 'g.wallet_id')
      .select(['g.id', 'g.user_id', 'g.wallet_id', 'g.token_in', 'g.amount_in', 'w.safe_address'])
      .where('g.status', '=', 'FAILED')
      .where('g.allowance_notified_at', 'is', null)
      .limit(100)
      .execute();
    let notified = 0;
    for (const group of groups) {
      if (group.safe_address === null) continue;
      const safe = bufferToAddress(group.safe_address);
      const token = bufferToAddress(group.token_in);
      const { value } = await this.#d.rpc.readSensitive('swap-residual-allowance', (client, blockNumber) =>
        client
          .readContract({
            address: token,
            abi: allowanceAbi,
            functionName: 'allowance',
            args: [safe, executor],
            blockNumber,
          })
          .then((a) => a.toString()),
      );
      const allowance = BigInt(value);
      const created = await withTransaction(
        this.#d.db,
        async (trx) => {
          const marked = await trx
            .updateTable('operation_groups')
            .set({ allowance_notified_at: new Date() })
            .where('id', '=', group.id)
            .where('allowance_notified_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          if (!marked || allowance === 0n) return false;
          await this.#d.audit.append(trx, {
            actorType: ACTOR.type,
            actorId: ACTOR.id,
            userId: group.user_id,
            walletId: group.wallet_id,
            eventType: 'SWAP_RESIDUAL_ALLOWANCE',
            targetType: 'operation_group',
            targetId: group.id,
            payload: { token, allowance: allowance.toString(), safe },
          });
          return notify(
            trx,
            {
              userId: group.user_id,
              walletId: group.wallet_id,
              type: 'RESIDUAL_ALLOWANCE',
              payload: { groupId: group.id, token, allowance: allowance.toString(), nextActions: ['REVOKE_APPROVAL'] },
              dedupeKey: `RESIDUAL_ALLOWANCE:${group.id}`,
            },
            this.#d.metrics,
          );
        },
        { auditLock: true },
      );
      if (created) notified++;
    }
    return notified;
  }
}
