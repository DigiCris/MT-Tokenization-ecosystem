// Grupos de operaciones de un swap (P14.T05): el estado del grupo se deriva de sus operaciones.
//
// - OPEN: alguna operación sigue en curso (sin firmar, encolada, en el worker, minada sin confirmar…).
// - COMPLETED: un SWAP del grupo quedó confirmado (allowance consumida por el swap).
// - FAILED: nada en curso, ningún swap ejecutado y quedó allowance de un approve ejecutado (sin un APPROVE_REVOKE
//   ejecutado después): se ofrece volver a cotizar (par nuevo approve + swap) o revocar la allowance.
// - CANCELLED: nada en curso y no quedó allowance (el approve nunca se ejecutó o se revocó).
//
// Un par que todavía no se encoló (alguna mitad sin la firma de U) se descarta entero: CREATED → CANCELLED y la mitad
// ya firmada USER_SIGNED → FAILED_FINAL (S nunca la co-firmó, así que su nonce se libera sin NoOp).
import { sql, type Selectable, type Transaction } from 'kysely';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { AuditActorType, Database, OperationGroupsTable, OperationStatus } from '../db/schema.ts';
import { EXECUTED_STATUSES } from './pairing.ts';
import type { OperationStateMachine } from './state-machine.ts';

export type GroupStatus = OperationGroupsTable['status'];
export const OPERATION_GROUP_STATUSES = [
  'OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly GroupStatus[];
type GroupRow = Selectable<OperationGroupsTable>;

/** Estados en los que una operación todavía puede cambiar (o ejecutarse). */
const PENDING_STATUSES: readonly OperationStatus[] = [
  'CREATED',
  'USER_SIGNED',
  'QUEUED',
  'VALIDATING',
  'READY',
  'SUBMITTED',
  'FAILED_RETRYABLE',
  'CANCEL_REQUESTED',
  'REORGED',
];

export interface GroupMember {
  operation_type: string;
  status: OperationStatus;
  safe_nonce: string;
  failure_reason?: string | null;
  last_error_code?: string | null;
}

export function deriveGroupStatus(ops: readonly GroupMember[]): { status: GroupStatus; failureReason: string | null } {
  if (ops.some((o) => o.operation_type === 'SWAP' && (o.status === 'CONFIRMED' || o.status === 'FINALIZED'))) {
    return { status: 'COMPLETED', failureReason: null };
  }
  const pending = ops.some(
    (o) => PENDING_STATUSES.includes(o.status) || (o.operation_type === 'SWAP' && o.status === 'MINED'),
  );
  if (pending) return { status: 'OPEN', failureReason: null };
  const lastExecuted = (type: string) =>
    ops
      .filter((o) => o.operation_type === type && EXECUTED_STATUSES.includes(o.status))
      .reduce<bigint | null>((max, o) => {
        const n = BigInt(o.safe_nonce);
        return max === null || n > max ? n : max;
      }, null);
  const approve = lastExecuted('SWAP_APPROVE');
  const revoke = lastExecuted('APPROVE_REVOKE');
  if (approve !== null && (revoke === null || revoke < approve)) {
    const swap = [...ops]
      .filter((o) => o.operation_type === 'SWAP')
      .sort((a, b) => (BigInt(a.safe_nonce) < BigInt(b.safe_nonce) ? 1 : -1))[0];
    return { status: 'FAILED', failureReason: swap?.last_error_code ?? swap?.failure_reason ?? 'SWAP_NOT_EXECUTED' };
  }
  return { status: 'CANCELLED', failureReason: null };
}

/** Bloquea el grupo hasta el fin de la transacción (las dos firmas del par pueden llegar a la vez). */
export async function lockGroup(trx: Transaction<Database>, groupId: string): Promise<GroupRow | undefined> {
  return trx.selectFrom('operation_groups').selectAll().where('id', '=', groupId).forUpdate().executeTakeFirst();
}

/** Recalcula el estado del grupo desde sus operaciones; audita el cambio (`SWAP_GROUP_<ESTADO>`). */
export async function refreshGroupStatus(
  trx: Transaction<Database>,
  audit: AuditWriter,
  groupId: string,
  actor: { type: AuditActorType; id: string },
): Promise<{ from: GroupStatus; to: GroupStatus } | null> {
  const group = await lockGroup(trx, groupId);
  if (!group) return null;
  const ops = await trx
    .selectFrom('wallet_operations')
    .select(['operation_type', 'status', 'safe_nonce', 'failure_reason', 'last_error_code'])
    .where('group_id', '=', groupId)
    .execute();
  const derived = deriveGroupStatus(ops);
  if (derived.status === group.status) return null;
  await trx
    .updateTable('operation_groups')
    .set({
      status: derived.status,
      failure_reason: derived.failureReason,
      ...(derived.status === 'COMPLETED' ? { completed_at: sql`now()` } : {}),
    })
    .where('id', '=', groupId)
    .execute();
  await audit.append(trx, {
    actorType: actor.type,
    actorId: actor.id,
    userId: group.user_id,
    walletId: group.wallet_id,
    eventType: `SWAP_GROUP_${derived.status}`,
    targetType: 'operation_group',
    targetId: groupId,
    payload: { from: group.status, to: derived.status, failureReason: derived.failureReason },
  });
  return { from: group.status, to: derived.status };
}

/**
 * Descarta el par sin encolar de un grupo (CREATED → CANCELLED, USER_SIGNED sin co-firma de S → FAILED_FINAL). La
 * wallet y el grupo tienen que estar bloqueados; el llamador recalcula el próximo nonce y el estado del grupo.
 */
export async function discardUnqueuedPair(
  trx: Transaction<Database>,
  machine: OperationStateMachine,
  groupId: string,
  input: { actor: { type: AuditActorType; id: string }; requestId?: string; reason: string },
): Promise<OperationStatus[]> {
  const ops = await trx
    .selectFrom('wallet_operations')
    .select(['id', 'status', 's_signature'])
    .where('group_id', '=', groupId)
    .where('status', 'in', ['CREATED', 'USER_SIGNED'])
    .orderBy('safe_nonce')
    .execute();
  const changed: OperationStatus[] = [];
  for (const op of ops) {
    if (op.status === 'USER_SIGNED' && op.s_signature !== null) continue;
    const to: OperationStatus = op.status === 'CREATED' ? 'CANCELLED' : 'FAILED_FINAL';
    await machine.transitionIn(trx, {
      operationId: op.id,
      from: [op.status],
      to,
      actor: input.actor,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      patch: { failure_reason: input.reason, ...(to === 'FAILED_FINAL' ? { last_error_code: input.reason } : {}) },
    });
    changed.push(to);
  }
  return changed;
}
