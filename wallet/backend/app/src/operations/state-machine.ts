// Máquina de estados de `wallet_operations` [B-SM] (P13.T01). Toda transición pasa por `transition`, en UNA
// transacción de la DB [B-SM-01]: `UPDATE … WHERE id = $1 AND status = ANY($2) [AND lease_version = $3]`, el evento de
// auditoría `OPERATION_<ESTADO>` [B-SM-02] y, si corresponde, el evento de outbox. Si no actualizó ninguna fila (otro
// worker o el estado cambió) es un conflicto y no hay ningún efecto. La tabla de transiciones permitidas es la del
// diagrama de §7.4; cualquier otra se rechaza antes de tocar la base.
import { sql, type Kysely, type Transaction, type Updateable } from 'kysely';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { OutboxEventInput, OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { AuditActorType, Database, OperationStatus, WalletOperationsTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';

export const OPERATION_STATUSES = [
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
] as const satisfies readonly OperationStatus[];

/** Transiciones permitidas [B-SM] (§7.4). */
export const ALLOWED_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  // Sin firma: la firma válida la encola; a los 15 min vence; cancelarla la descarta (nonce liberado).
  CREATED: ['USER_SIGNED', 'EXPIRED', 'CANCELLED'],
  USER_SIGNED: ['QUEUED', 'CANCEL_REQUESTED'],
  // FAILED_FINAL sin pasar por el worker (agregado al diagrama de §7.4): la NoOp que perdió la carrera de cancelación
  // ([B-NONCE-06]) o una firma de más de 24 h que esperaba un nonce menor ([B-PSES-06], SIGNATURE_STALE).
  QUEUED: ['VALIDATING', 'CANCEL_REQUESTED', 'FAILED_FINAL'],
  VALIDATING: ['READY', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  // Firma S + broadcast; una falla del signer o del broadcast es transitoria o definitiva.
  READY: ['SUBMITTED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCEL_REQUESTED'],
  // Receipt success → MINED; status 0 o dropped → reintentable o definitivo ([B-SM-04]).
  SUBMITTED: ['MINED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCEL_REQUESTED'],
  MINED: ['CONFIRMED', 'REORGED'],
  CONFIRMED: ['FINALIZED', 'REORGED'],
  FINALIZED: [],
  FAILED_RETRYABLE: ['QUEUED', 'FAILED_FINAL', 'CANCEL_REQUESTED'],
  // Terminal; con la firma vigente se ofrece cancelar por NoOp ([B-SM-03]).
  FAILED_FINAL: ['CANCEL_REQUESTED'],
  // Se revalida y se retransmite la MISMA SafeTx; si la misma tx de S volvió a incluirse en otro bloque, MINED
  // (agregado al diagrama de §7.4: no hace falta re-ejecutar lo que la cadena canónica ya contiene).
  REORGED: ['QUEUED', 'MINED'],
  // Gana la que se mine primero: la NoOp (CANCELLED) o la original (MINED).
  CANCEL_REQUESTED: ['CANCELLED', 'MINED'],
  CANCELLED: [],
  EXPIRED: [],
};

/** Estados terminales [B-SM-03] (CONFIRMED es estable pero el watcher lo sigue hasta FINALIZED). */
export const TERMINAL_STATUSES: readonly OperationStatus[] = ['FINALIZED', 'FAILED_FINAL', 'CANCELLED', 'EXPIRED'];

export function isAllowedTransition(from: OperationStatus, to: OperationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
}

/** El UPDATE no afectó ninguna fila: la operación no estaba en los estados esperados o el lease no es el vigente. */
export class TransitionConflictError extends Error {
  override name = 'TransitionConflictError';
}

export interface TransitionInput {
  operationId: string;
  from: readonly OperationStatus[];
  to: OperationStatus;
  /** Columnas que cambian junto con el estado (tx, bloque, error, reintentos…). */
  patch?: Omit<Updateable<WalletOperationsTable>, 'id' | 'status'>;
  /** Fencing [B-NONCE-04]: sólo transiciona si `lease_version` coincide (el worker que tiene el lease). */
  leaseVersion?: bigint;
  actor: { type: AuditActorType; id: string | null };
  requestId?: string | null;
  /** Datos extra del evento de auditoría (nunca secretos: se guardan redactados). */
  detail?: Record<string, unknown>;
  /** Evento de outbox de la transición (p. ej. OPERATION_QUEUED). */
  outbox?: Omit<OutboxEventInput, 'aggregateType' | 'aggregateId'>;
}

export interface TransitionResult {
  operationId: string;
  from: OperationStatus;
  to: OperationStatus;
  walletId: string;
  userId: string;
}

export interface StateMachineDeps {
  db: Kysely<Database>;
  audit: AuditWriter;
  outbox: OutboxRepository;
}

export class OperationStateMachine {
  readonly #d: StateMachineDeps;

  constructor(deps: StateMachineDeps) {
    this.#d = deps;
  }

  /** Transición en su propia transacción. */
  async transition(input: TransitionInput): Promise<TransitionResult> {
    return withTransaction(this.#d.db, (trx) => this.transitionIn(trx, input), { auditLock: true });
  }

  /**
   * Transición dentro de la transacción del llamador (que tiene que haber tomado el lock de auditoría: withTransaction
   * con `auditLock`).
   */
  async transitionIn(trx: Transaction<Database>, input: TransitionInput): Promise<TransitionResult> {
    if (input.from.length === 0) throw new InvalidTransitionError('sin estados de origen');
    for (const from of input.from) {
      if (!isAllowedTransition(from, input.to))
        throw new InvalidTransitionError(`${from} → ${input.to} no está permitida`);
    }
    const current = await trx
      .selectFrom('wallet_operations')
      .select(['status', 'wallet_id', 'user_id'])
      .where('id', '=', input.operationId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new TransitionConflictError(`operación ${input.operationId} inexistente`);
    let query = trx
      .updateTable('wallet_operations')
      .set({ ...input.patch, status: input.to, updated_at: sql`now()` })
      .where('id', '=', input.operationId)
      .where('status', 'in', input.from);
    if (input.leaseVersion !== undefined) query = query.where('lease_version', '=', input.leaseVersion.toString());
    const updated = await query.executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      throw new TransitionConflictError(
        `operación ${input.operationId}: estado ${current.status} o lease distinto (esperado ${input.from.join('|')})`,
      );
    }
    await this.#d.audit.append(trx, {
      actorType: input.actor.type,
      actorId: input.actor.id,
      userId: current.user_id,
      walletId: current.wallet_id,
      eventType: `OPERATION_${input.to}`,
      targetType: 'operation',
      targetId: input.operationId,
      requestId: input.requestId ?? null,
      payload: { from: current.status, to: input.to, ...input.detail },
    });
    if (input.outbox) {
      await this.#d.outbox.enqueue(trx, {
        aggregateType: 'operation',
        aggregateId: input.operationId,
        ...input.outbox,
      });
    }
    return {
      operationId: input.operationId,
      from: current.status,
      to: input.to,
      walletId: current.wallet_id,
      userId: current.user_id,
    };
  }
}
