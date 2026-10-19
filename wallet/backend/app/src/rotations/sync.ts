// Sincronización de rotaciones en el worker (P15.T01/T03/T07): la verdad es la cadena.
//
// 1. Pedido ↔ operación: AWAITING_SIGNATURE → PROPOSING cuando U o R firmaron la propuesta (si vence o se cancela
//    sin firmarse, la de U vuelve a DRAFT —el material de U' sigue registrado— y las demás quedan FAILED); con la
//    ejecución firmada, EXECUTING (si falla, vuelve a READY_TO_EXECUTE con el motivo).
// 2. Eventos confirmados de RotationTimelock (los indexa el indexer, con finalidad y reorgs), en orden de bloque:
//    `RotationProposed` → PENDING_TIMELOCK con el id y `executableAt` del evento; si nadie del backend la preparó (U+R
//    soberano, otro frontend), se registra igual con origen ONCHAIN y se notifica [B-MAIL-03];
//    `RotationCancelled` → CANCELLED (quién: U, R o la propia Safe); `RotationExecuted` → EXECUTED con sus efectos:
//    U' → registro OPAQUE ACTIVE y el anterior RETIRED; R' → su enrollment CONFIRMED y el anterior RETIRED;
//    S' → signer_keys ACTIVE y la anterior RETIRED; en los tres, los metadatos de claves. Email y notificación en cada
//    caso; cada evento se aplica una sola vez.
// 3. Madurez: PENDING_TIMELOCK con `executableAt` ≤ timestamp del bloque head → READY_TO_EXECUTE (notificación).
// 4. Retiro en el signer ([B-SIG-08]): cada S que dejó de ser la de su Safe (rotada o reemplazada por U + R) se retira
//    en su shard (deja de firmar; keystore destruido a los 30 días); un shard caído se reintenta en la pasada siguiente.
//
// Aislamiento de fallas (revisión de seguridad de ADR-033, ALTO 1): cada paso corre aunque otro falle, y un evento que no
// se puede aplicar (p. ej. un efecto que viola un constraint) no frena a los demás: queda en cuarentena con el error, la
// alerta `ROTATION_EVENT_QUARANTINED` y la métrica, y se reintenta con espera exponencial. Los eventos posteriores de su
// misma Safe esperan detrás de él (el orden por Safe no se pierde); los de las otras Safes siguen. Sin quórum de RPC, el
// evento que lo necesita (una cancelación) y los siguientes de su Safe esperan a la próxima pasada, sin cuarentena.
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { isAddressEqual, type Address } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { securityGuardAbi } from '../chain/abis/index.ts';
import { RpcQuorumError, type RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database, OperationStatus, RotationEventsTable, RotationRole } from '../db/schema.ts';
import { TransactionRetriesExhaustedError, withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { guardOfTimelock } from '../policy/guards.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { SignerClientError } from '../signer-client/client.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';

type EventRow = Selectable<RotationEventsTable>;

const ROLE_OF_KIND: readonly RotationRole[] = ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'];
const SIGNED: readonly OperationStatus[] = [
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
const DEAD: readonly OperationStatus[] = ['EXPIRED', 'CANCELLED', 'FAILED_FINAL'];
const APPLICABLE = ['CONFIRMED', 'FINALIZED'] as const;

/** Espera de la cuarentena: 30 s después del primer intento fallido, el doble en cada uno siguiente, hasta 1 h. */
const QUARANTINE_BASE_DELAY_MS = 30_000;
const QUARANTINE_MAX_DELAY_MS = 3_600_000;

export function quarantineDelayMs(attempts: number): number {
  return Math.min(QUARANTINE_MAX_DELAY_MS, QUARANTINE_BASE_DELAY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 20));
}

/** Lo que se registra recién con la transacción del evento confirmada (su cuerpo puede repetirse en un reintento). */
type AfterCommit = (() => void)[];

export interface RotationSyncDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  snapshot: () => BackendPolicySnapshot;
  logger: Logger;
  metrics?: Metrics;
  /** Shards del signer: retiro de las S que dejaron de ser las de su Safe (sin él, no se retiran). */
  signerKeys?: SignerKeyService;
}

export interface RotationSyncResult {
  operations: number;
  applied: number;
  /** Eventos que fallaron en esta pasada y quedaron (o siguen) en cuarentena. */
  quarantined: number;
  ready: number;
  retired: number;
}

export class RotationSync {
  readonly #d: RotationSyncDeps;

  constructor(deps: RotationSyncDeps) {
    this.#d = deps;
  }

  async runOnce(): Promise<RotationSyncResult> {
    // Cada paso corre aunque falle otro: un evento o un pedido que no se puede procesar no frena la madurez de las
    // propuestas ni el retiro de las S en el signer. Al final se propaga el primer error (lo registra el lazo).
    const errors: unknown[] = [];
    const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof RpcQuorumError) {
          this.#d.logger.warn(
            { code: error.code, step: name },
            'sincronización de rotaciones sin quórum: se reintenta en la próxima pasada',
          );
        } else {
          errors.push(error);
        }
        return fallback;
      }
    };
    const operations = await step('operations', () => this.#syncOperations(), 0);
    const { applied, quarantined } = await step('events', () => this.#applyEvents(), { applied: 0, quarantined: 0 });
    await step('quarantine-gauge', () => this.#reportQuarantined(), undefined);
    const ready = await step('ready', () => this.#markReady(), 0);
    const retired = await step('signer-retire', () => this.#retireInSigner(), 0);
    if (errors.length > 0) throw errors[0];
    return { operations, applied, quarantined, ready, retired };
  }

  /** Gauge con los eventos en cuarentena (alerta mientras haya alguno). */
  async #reportQuarantined(): Promise<void> {
    const metrics = this.#d.metrics;
    if (metrics === undefined) return;
    const row = await this.#d.db
      .selectFrom('rotation_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('quarantined_at', 'is not', null)
      .where('applied_at', 'is', null)
      .where('status', 'in', APPLICABLE)
      .executeTakeFirst();
    metrics.rotationEventsQuarantined.set(Number(row?.n ?? 0));
  }

  /** Pide a cada shard el retiro de sus S ya retiradas en la base; idempotente del lado del signer. */
  async #retireInSigner(): Promise<number> {
    const signerKeys = this.#d.signerKeys;
    if (signerKeys === undefined) return 0;
    const rows = await this.#d.db
      .selectFrom('signer_keys as k')
      .innerJoin('wallets as w', 'w.id', 'k.wallet_id')
      .select(['k.id', 'k.wallet_id', 'k.shard_id', 'k.address', 'w.safe_address'])
      .where('k.status', '=', 'RETIRED')
      .where('k.signer_retired_at', 'is', null)
      .where('w.safe_address', 'is not', null)
      .orderBy('k.created_at')
      .limit(50)
      .execute();
    let retired = 0;
    for (const row of rows) {
      if (row.safe_address === null) continue;
      const address = bufferToAddress(row.address);
      try {
        await signerKeys.client(row.shard_id).retireKey({
          walletId: row.wallet_id,
          address,
          safe: bufferToAddress(row.safe_address),
        });
      } catch (error) {
        // Un shard que ya no tiene la clave (perdida con su registro) no tiene nada que retirar.
        if (!(error instanceof SignerClientError && error.code === 'KEY_NOT_FOUND')) {
          this.#d.logger.warn(
            { err: error, walletId: row.wallet_id, shardId: row.shard_id },
            'retiro de S en el signer fallido: se reintenta en la próxima pasada',
          );
          continue;
        }
        this.#d.logger.warn({ walletId: row.wallet_id, shardId: row.shard_id }, 'la S retirada no existe en su shard');
      }
      await this.#d.db
        .updateTable('signer_keys')
        .set({ signer_retired_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      retired++;
    }
    return retired;
  }

  async #syncOperations(): Promise<number> {
    let changed = 0;
    const proposals = await this.#d.db
      .selectFrom('rotation_requests as r')
      .innerJoin('wallet_operations as o', 'o.id', 'r.propose_operation_id')
      .select(['r.id', 'r.status', 'r.role', 'r.opaque_record_id', 'o.status as op_status', 'o.last_error_code'])
      .where('r.status', 'in', ['AWAITING_SIGNATURE', 'PROPOSING'])
      .limit(500)
      .execute();
    for (const row of proposals) {
      let patch: { status: 'DRAFT' | 'PROPOSING' | 'FAILED'; failure_reason: string | null } | null = null;
      if (row.status === 'AWAITING_SIGNATURE' && SIGNED.includes(row.op_status)) {
        patch = { status: 'PROPOSING', failure_reason: null };
      } else if (DEAD.includes(row.op_status)) {
        const reason =
          row.op_status === 'FAILED_FINAL' ? (row.last_error_code ?? 'PROPOSAL_FAILED') : `PROPOSAL_${row.op_status}`;
        // La de U conserva el registro de U' y su KeyAcceptance: vuelve a DRAFT para proponerla de nuevo.
        patch = {
          status: row.role === 'U' && row.opaque_record_id !== null ? 'DRAFT' : 'FAILED',
          failure_reason: reason,
        };
      }
      if (patch === null) continue;
      const updated = await this.#d.db
        .updateTable('rotation_requests')
        .set({ ...patch, ...(patch.status === 'DRAFT' ? { propose_operation_id: null } : {}) })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) changed++;
    }
    const executions = await this.#d.db
      .selectFrom('rotation_requests as r')
      .innerJoin('wallet_operations as o', 'o.id', 'r.execute_operation_id')
      .select(['r.id', 'r.status', 'o.status as op_status', 'o.last_error_code'])
      .where('r.status', 'in', ['PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING'])
      .limit(500)
      .execute();
    for (const row of executions) {
      let patch: { status: 'EXECUTING' | 'READY_TO_EXECUTE'; failure_reason: string | null } | null = null;
      if (row.status !== 'EXECUTING' && SIGNED.includes(row.op_status))
        patch = { status: 'EXECUTING', failure_reason: null };
      else if (DEAD.includes(row.op_status) && row.status === 'EXECUTING') {
        patch = { status: 'READY_TO_EXECUTE', failure_reason: row.last_error_code ?? `EXECUTION_${row.op_status}` };
      }
      if (patch === null) continue;
      const updated = await this.#d.db
        .updateTable('rotation_requests')
        .set(patch)
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) changed++;
    }
    return changed;
  }

  async #applyEvents(): Promise<{ applied: number; quarantined: number }> {
    const now = new Date();
    const events = await this.#d.db
      .selectFrom('rotation_events as e')
      .selectAll('e')
      .where('e.applied_at', 'is', null)
      .where('e.status', 'in', APPLICABLE)
      // Uno en cuarentena se reintenta cuando vence su espera.
      .where((eb) => eb.or([eb('e.retry_at', 'is', null), eb('e.retry_at', '<=', now)]))
      // Los posteriores de una Safe con un evento en cuarentena esperan detrás de él: el orden por Safe no se pierde.
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('rotation_events as q')
              .select('q.id')
              .whereRef('q.chain_id', '=', 'e.chain_id')
              .whereRef('q.safe_address', '=', 'e.safe_address')
              .where('q.quarantined_at', 'is not', null)
              .where('q.applied_at', 'is', null)
              .where('q.status', 'in', APPLICABLE)
              .where(sql<boolean>`(q.block_number, q.log_index) < (e.block_number, e.log_index)`),
          ),
        ),
      )
      .orderBy('e.block_number')
      .orderBy('e.log_index')
      .limit(200)
      .execute();
    let applied = 0;
    let quarantined = 0;
    // Safes con un evento que no se aplicó en esta pasada: sus eventos siguientes esperan a la próxima.
    const held = new Set<string>();
    for (const event of events) {
      const safeKey = `${String(event.chain_id)}:${bufferToHex(event.safe_address)}`;
      if (held.has(safeKey)) continue;
      try {
        if (await this.#apply(event)) applied++;
      } catch (error) {
        held.add(safeKey);
        // Transitorio (sin quórum de RPC o con los reintentos por serialización agotados): sin cuarentena.
        if (error instanceof RpcQuorumError || error instanceof TransactionRetriesExhaustedError) {
          this.#d.logger.warn(
            { err: error, eventId: event.id, kind: event.kind, safe: bufferToAddress(event.safe_address) },
            'evento de rotación sin aplicar: se reintenta en la próxima pasada',
          );
          continue;
        }
        await this.#quarantine(event, error);
        quarantined++;
      }
    }
    return { applied, quarantined };
  }

  /** Aplica un evento una sola vez (true si lo aplicó esta pasada); uno que estaba en cuarentena sale de ella. */
  async #apply(event: EventRow): Promise<boolean> {
    // Quién canceló se resuelve contra los roles on-chain (fuera de la transacción).
    const roles =
      event.kind === 'CANCELLED'
        ? await this.#roles(bufferToAddress(event.safe_address), bufferToAddress(event.timelock))
        : null;
    let after: AfterCommit = [];
    const done = await withTransaction(
      this.#d.db,
      async (trx) => {
        after = [];
        const claimed = await trx
          .updateTable('rotation_events')
          .set({ applied_at: new Date(), quarantined_at: null, retry_at: null })
          .where('id', '=', event.id)
          .where('applied_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!claimed) return false;
        if (event.kind === 'PROPOSED') await this.#proposed(trx, event);
        else if (event.kind === 'CANCELLED') await this.#cancelled(trx, event, roles);
        else await this.#executed(trx, event, after);
        return true;
      },
      { auditLock: true },
    );
    if (!done) return false;
    for (const log of after) log();
    if (event.quarantined_at !== null) {
      this.#d.logger.info(
        { eventId: event.id, kind: event.kind, attempts: event.apply_attempts },
        'evento de rotación aplicado: salió de la cuarentena',
      );
    }
    return true;
  }

  /**
   * Un evento que no se pudo aplicar queda en cuarentena con el error y el próximo intento (espera exponencial). La
   * alerta sale al entrar; los reintentos fallidos suman a la métrica, y el gauge sigue mientras esté en cuarentena.
   */
  async #quarantine(event: EventRow, error: unknown): Promise<void> {
    const attempts = event.apply_attempts + 1;
    const retryAt = new Date(Date.now() + quarantineDelayMs(attempts));
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
    await this.#d.db
      .updateTable('rotation_events')
      .set({
        apply_attempts: attempts,
        apply_error: message,
        quarantined_at: event.quarantined_at ?? new Date(),
        retry_at: retryAt,
      })
      .where('id', '=', event.id)
      .where('applied_at', 'is', null)
      .execute();
    this.#d.metrics?.rotationEventApplyFailures.inc({ kind: event.kind });
    const fields = {
      eventId: event.id,
      kind: event.kind,
      safe: bufferToAddress(event.safe_address),
      proposalId: bufferToHex(event.proposal_id),
      txHash: bufferToHex(event.tx_hash),
      blockNumber: event.block_number,
      attempts,
      retryAt: retryAt.toISOString(),
      err: error,
    };
    if (event.quarantined_at === null) {
      this.#d.logger.error(
        { alert: 'ROTATION_EVENT_QUARANTINED', ...fields },
        'evento de rotación en cuarentena: no se pudo aplicar; los siguientes de su Safe esperan y los demás siguen',
      );
    } else {
      this.#d.logger.warn(fields, 'el evento de rotación sigue en cuarentena');
    }
  }

  /** Roles de la Safe en el Guard dueño del timelock del evento (quien validó la cancelación on-chain). */
  async #roles(safe: Address, timelock: Address): Promise<{ userKey: Address; recoveryKey: Address } | null> {
    const snapshot = this.#d.snapshot();
    const guard = guardOfTimelock(snapshot, timelock)?.guard ?? snapshot.contracts.securityGuard;
    const { value } = await this.#d.rpc.readSensitive('rotation-roles', (client, blockNumber) =>
      client.readContract({
        address: guard,
        abi: securityGuardAbi,
        functionName: 'rolesOf',
        args: [safe],
        blockNumber,
      }),
    );
    return { userKey: value.userKey, recoveryKey: value.recoveryKey };
  }

  async #walletOf(trx: Transaction<Database>, event: EventRow) {
    return trx
      .selectFrom('wallets as w')
      .innerJoin('users as u', 'u.id', 'w.user_id')
      .select(['w.id', 'w.user_id', 'u.email', 'u.locale', 'u.time_zone'])
      .where('w.chain_id', '=', event.chain_id)
      .where('w.safe_address', '=', event.safe_address)
      .executeTakeFirstOrThrow();
  }

  async #proposed(trx: Transaction<Database>, event: EventRow): Promise<void> {
    const wallet = await this.#walletOf(trx, event);
    const role = ROLE_OF_KIND[event.rotation_kind ?? -1];
    if (role === undefined || event.old_value === null || event.new_value === null || event.executable_at === null) {
      throw new Error(`evento RotationProposed incompleto (${event.id})`);
    }
    const safe = bufferToAddress(event.safe_address);
    // La que preparó el backend: misma tx que su operación de propuesta.
    const platform = await trx
      .selectFrom('rotation_requests as r')
      .innerJoin('wallet_operations as o', 'o.id', 'r.propose_operation_id')
      .select(['r.id'])
      .where('r.wallet_id', '=', wallet.id)
      .where('o.tx_hash', '=', event.tx_hash)
      .where('r.status', 'in', ['AWAITING_SIGNATURE', 'PROPOSING', 'FAILED', 'DRAFT'])
      .executeTakeFirst();
    const patch = {
      status: 'PENDING_TIMELOCK' as const,
      proposal_id: event.proposal_id,
      executable_at: event.executable_at,
      proposed_at: new Date(),
      propose_tx_hash: event.tx_hash,
      timelock: event.timelock,
      failure_reason: null,
    };
    let rotationId: string;
    let origin: 'PLATFORM' | 'ONCHAIN';
    if (platform) {
      await trx.updateTable('rotation_requests').set(patch).where('id', '=', platform.id).execute();
      rotationId = platform.id;
      origin = 'PLATFORM';
    } else {
      rotationId = (
        await trx
          .insertInto('rotation_requests')
          .values({
            wallet_id: wallet.id,
            role,
            old_key: event.old_value,
            new_key: event.new_value,
            initiated_by: 'SAFE',
            origin: 'ONCHAIN',
            ...patch,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      origin = 'ONCHAIN';
    }
    const occurredAt = new Date().toISOString();
    const params = {
      role,
      oldKey: bufferToAddress(event.old_value),
      newKey: bufferToAddress(event.new_value),
      safe,
      executableAt: event.executable_at.toISOString(),
      occurredAt,
    };
    const created = await notify(
      trx,
      {
        userId: wallet.user_id,
        walletId: wallet.id,
        type: 'ROTATION_PROPOSED',
        payload: { rotationId, origin, ...params, proposalId: bufferToHex(event.proposal_id) },
        dedupeKey: `ROTATION_PROPOSED:${bufferToHex(event.proposal_id)}`,
      },
      this.#d.metrics,
    );
    if (created) {
      await this.#d.emails?.enqueue(trx, {
        to: wallet.email,
        template: 'rotation-proposed',
        params: {
          ...params,
          origin: { ipPrefix: null, userAgent: origin === 'ONCHAIN' ? 'propuesta on-chain' : null },
        },
        locale: wallet.locale,
        timeZone: wallet.time_zone,
        product: 'Wallet',
      });
    }
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'rotation-sync',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType: 'ROTATION_PROPOSED',
      targetType: 'rotation',
      targetId: rotationId,
      payload: { ...params, origin, proposalId: bufferToHex(event.proposal_id), txHash: bufferToHex(event.tx_hash) },
    });
  }

  async #cancelled(
    trx: Transaction<Database>,
    event: EventRow,
    roles: { userKey: Address; recoveryKey: Address } | null,
  ): Promise<void> {
    const wallet = await this.#walletOf(trx, event);
    const safe = bufferToAddress(event.safe_address);
    const actor = event.actor === null ? null : bufferToAddress(event.actor);
    const cancelledBy: 'U' | 'R' | 'SAFE' =
      actor !== null && isAddressEqual(actor, safe)
        ? 'SAFE'
        : actor !== null && roles !== null && isAddressEqual(actor, roles.recoveryKey)
          ? 'R'
          : 'U';
    const rotation = await trx
      .updateTable('rotation_requests')
      .set({ status: 'CANCELLED', cancelled_by: cancelledBy, cancel_tx_hash: event.tx_hash })
      .where('wallet_id', '=', wallet.id)
      .where('proposal_id', '=', event.proposal_id)
      .where('status', 'in', ['PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING'])
      .returning(['id', 'role'])
      .executeTakeFirst();
    const role = rotation?.role ?? null;
    const occurredAt = new Date().toISOString();
    if (role !== null) {
      const created = await notify(
        trx,
        {
          userId: wallet.user_id,
          walletId: wallet.id,
          type: 'ROTATION_CANCELLED',
          payload: { rotationId: rotation?.id, role, safe, cancelledBy, occurredAt },
          dedupeKey: `ROTATION_CANCELLED:${bufferToHex(event.proposal_id)}`,
        },
        this.#d.metrics,
      );
      if (created) {
        await this.#d.emails?.enqueue(trx, {
          to: wallet.email,
          template: 'rotation-cancelled',
          params: { role, safe, cancelledBy, occurredAt },
          locale: wallet.locale,
          timeZone: wallet.time_zone,
          product: 'Wallet',
        });
      }
    }
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'rotation-sync',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType: 'ROTATION_CANCELLED',
      targetType: 'rotation',
      targetId: rotation?.id ?? null,
      payload: { proposalId: bufferToHex(event.proposal_id), cancelledBy, actor, txHash: bufferToHex(event.tx_hash) },
    });
  }

  async #executed(trx: Transaction<Database>, event: EventRow, after: AfterCommit): Promise<void> {
    const wallet = await this.#walletOf(trx, event);
    const safe = bufferToAddress(event.safe_address);
    const rotation = await trx
      .updateTable('rotation_requests')
      .set({ status: 'EXECUTED', executed_at: new Date(), execute_tx_hash: event.tx_hash, failure_reason: null })
      .where('wallet_id', '=', wallet.id)
      .where('proposal_id', '=', event.proposal_id)
      .where('status', 'in', ['PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING'])
      .returningAll()
      .executeTakeFirst();
    if (!rotation) {
      this.#d.logger.warn(
        { walletId: wallet.id, proposalId: bufferToHex(event.proposal_id) },
        'rotación ejecutada sin pedido vivo',
      );
      return;
    }
    const oldKey = bufferToAddress(rotation.old_key);
    const newKey = bufferToAddress(rotation.new_key);
    const now = new Date();
    // R′ de un pedido de reemplazo: la Wallet lo pudo haber rechazado (posible sustitución) con la rotación ya en curso.
    // Desde la revisión de ADR-033 el backend no acepta ese rechazo, pero una fila anterior o una carrera lo dejan así: la
    // cadena manda (R′ ya es owner), así que el pedido queda CONFIRMED igual y sale la alerta.
    const enrollment =
      rotation.role === 'R' && rotation.enrollment_id !== null
        ? await trx
            .selectFrom('recovery_metadata')
            .select(['id', 'enrollment_id', 'status', 'rejection_reason'])
            .where('id', '=', rotation.enrollment_id)
            .forUpdate()
            .executeTakeFirst()
        : undefined;
    const rejected = enrollment?.status === 'REJECTED';
    if (rotation.role === 'U' || rotation.role === 'R' || rotation.role === 'S') {
      // Metadatos de claves: la anterior ROTATED_OUT; la nueva ACTIVE (U' y R' ya estaban PENDING; S' se agrega).
      await trx
        .updateTable('wallet_keys_metadata')
        .set({ status: 'ROTATED_OUT', deactivated_at: now })
        .where('wallet_id', '=', wallet.id)
        .where('role', '=', rotation.role)
        .where('status', '=', 'ACTIVE')
        .execute();
      const pending = await trx
        .updateTable('wallet_keys_metadata')
        .set({ status: 'ACTIVE', activated_at: now })
        .where('wallet_id', '=', wallet.id)
        .where('role', '=', rotation.role)
        .where('key_address', '=', addressToBuffer(newKey))
        .where('status', '=', 'PENDING')
        .returning('id')
        .executeTakeFirst();
      // El rechazo había dejado REVOKED la fila de R′: vuelve a estar viva (con su origen y sus backups).
      const revoked =
        !pending && rejected
          ? await trx
              .selectFrom('wallet_keys_metadata')
              .select('id')
              .where('wallet_id', '=', wallet.id)
              .where('role', '=', 'R')
              .where('key_address', '=', addressToBuffer(newKey))
              .where('status', '=', 'REVOKED')
              .orderBy('key_version', 'desc')
              .executeTakeFirst()
          : undefined;
      if (revoked) {
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'ACTIVE', activated_at: now, deactivated_at: null })
          .where('id', '=', revoked.id)
          .execute();
      } else if (!pending) {
        const version = await trx
          .selectFrom('wallet_keys_metadata')
          .select((eb) => eb.fn.max('key_version').as('v'))
          .where('wallet_id', '=', wallet.id)
          .where('role', '=', rotation.role)
          .executeTakeFirst();
        await trx
          .insertInto('wallet_keys_metadata')
          .values({
            wallet_id: wallet.id,
            role: rotation.role,
            key_address: addressToBuffer(newKey),
            key_version: (version?.v ?? 0) + 1,
            status: 'ACTIVE',
            source: rotation.role === 'S' ? 'SIGNER_SHARD' : 'INTERNAL',
            activated_at: now,
          })
          .execute();
      }
    }
    if (rotation.role === 'U' && rotation.opaque_record_id !== null) {
      await trx
        .updateTable('opaque_records')
        .set({ status: 'RETIRED' })
        .where('wallet_id', '=', wallet.id)
        .where('status', '=', 'ACTIVE')
        .execute();
      await trx
        .updateTable('opaque_records')
        .set({ status: 'ACTIVE', activated_at: now })
        .where('id', '=', rotation.opaque_record_id)
        .execute();
    }
    if (rotation.role === 'R' && rotation.enrollment_id !== null) {
      await trx
        .updateTable('recovery_metadata')
        .set({ status: 'RETIRED', retired_at: now })
        .where('wallet_id', '=', wallet.id)
        .where('status', '=', 'CONFIRMED')
        .execute();
      // Sin el motivo ni el momento del rechazo (sólo existen en uno REJECTED); el aviso y su email quedan registrados.
      await trx
        .updateTable('recovery_metadata')
        .set({ status: 'CONFIRMED', confirmed_at: now, rejection_reason: null, rejected_at: null })
        .where('id', '=', rotation.enrollment_id)
        .execute();
      if (rejected) {
        const rejection = { enrollmentId: enrollment.enrollment_id, reason: enrollment.rejection_reason };
        after.push(() => {
          this.#d.logger.error(
            {
              alert: 'RECOVERY_REJECTED_KEY_EXECUTED',
              walletId: wallet.id,
              rotationId: rotation.id,
              proposalId: bufferToHex(event.proposal_id),
              newKey,
              ...rejection,
            },
            'se ejecutó on-chain la rotación hacia una R que la Wallet había rechazado: la cadena manda (posible sustitución de R)',
          );
        });
      }
    }
    if (rotation.role === 'S') {
      await trx
        .updateTable('signer_keys')
        .set({ status: 'RETIRED', retired_at: now })
        .where('wallet_id', '=', wallet.id)
        .where('status', '=', 'ACTIVE')
        .execute();
      await trx
        .updateTable('signer_keys')
        .set({ status: 'ACTIVE' })
        .where('wallet_id', '=', wallet.id)
        .where('address', '=', addressToBuffer(newKey))
        .execute();
    }
    const occurredAt = now.toISOString();
    const params = { role: rotation.role, oldKey, newKey, safe, occurredAt };
    const created = await notify(
      trx,
      {
        userId: wallet.user_id,
        walletId: wallet.id,
        type: 'ROTATION_EXECUTED',
        payload: { rotationId: rotation.id, ...params },
        dedupeKey: `ROTATION_EXECUTED:${bufferToHex(event.proposal_id)}`,
      },
      this.#d.metrics,
    );
    if (created) {
      await this.#d.emails?.enqueue(trx, {
        to: wallet.email,
        template: 'rotation-executed',
        params,
        locale: wallet.locale,
        timeZone: wallet.time_zone,
        product: 'Wallet',
      });
    }
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'rotation-sync',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType: 'ROTATION_EXECUTED',
      targetType: 'rotation',
      targetId: rotation.id,
      payload: { ...params, proposalId: bufferToHex(event.proposal_id), txHash: bufferToHex(event.tx_hash) },
    });
  }

  /** Propuestas maduras según el reloj de la cadena → READY_TO_EXECUTE (con notificación). */
  async #markReady(): Promise<number> {
    const pending = await this.#d.db
      .selectFrom('rotation_requests')
      .select(['id', 'wallet_id', 'role', 'executable_at'])
      .where('status', '=', 'PENDING_TIMELOCK')
      .orderBy('executable_at')
      .limit(200)
      .execute();
    if (pending.length === 0) return 0;
    const { value: head } = await this.#d.rpc.readSensitive('rotation-head-timestamp', (client, blockNumber) =>
      client.getBlock({ blockNumber }).then((b) => b.timestamp.toString()),
    );
    const headMs = Number(head) * 1000;
    let ready = 0;
    for (const row of pending) {
      if (row.executable_at === null || row.executable_at.getTime() > headMs) continue;
      const changed = await withTransaction(this.#d.db, async (trx) => {
        const updated = await trx
          .updateTable('rotation_requests')
          .set({ status: 'READY_TO_EXECUTE' })
          .where('id', '=', row.id)
          .where('status', '=', 'PENDING_TIMELOCK')
          .returning('id')
          .executeTakeFirst();
        if (!updated) return false;
        const wallet = await trx
          .selectFrom('wallets')
          .select('user_id')
          .where('id', '=', row.wallet_id)
          .executeTakeFirstOrThrow();
        await notify(
          trx,
          {
            userId: wallet.user_id,
            walletId: row.wallet_id,
            type: 'ROTATION_READY',
            payload: { rotationId: row.id, role: row.role },
            dedupeKey: `ROTATION_READY:${row.id}`,
          },
          this.#d.metrics,
        );
        return true;
      });
      if (changed) ready++;
    }
    return ready;
  }
}
