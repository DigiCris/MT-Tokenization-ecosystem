// Sincronización de la whitelist en el worker (P14.T01): la verdad es la cadena.
//
// 1. Pedidos ↔ operación: AWAITING_SIGNATURE → SUBMITTED cuando U firmó la SafeTx; EXPIRED/CANCELLED/FAILED cuando
//    la operación venció, se canceló o falló en forma definitiva (hay que pedir un alta nueva).
// 2. Eventos confirmados de DestinationWhitelist (los indexa el indexer, con finalidad y reorgs), en orden de bloque:
//    `DestinationAdded` → destino ACTIVATING con el `activatesAt` del evento (WHITELIST_CONFIRMED_ONCHAIN); si vino de
//    un pedido de la plataforma, el pedido pasa a ACTIVATING; si no, es un alta soberana (U+R por fuera) y se notifica.
//    `DestinationRemoved` → destino REMOVED (quién: U o R si fue una operación de la plataforma, SAFE si no) con email,
//    notificación y auditoría. Cada evento se aplica una sola vez.
// 3. Activación: ACTIVATING con `activatesAt` ≤ timestamp del bloque head → si `isWhitelisted` es true on-chain
//    (quórum), ACTIVE + email `whitelist-activated` + notificación (WHITELIST_ACTIVATED).
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Address } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { destinationWhitelistAbi } from '../chain/abis/index.ts';
import { RpcQuorumError, type RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database, OperationStatus, WhitelistEventsTable } from '../db/schema.ts';
import { sqlState, withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

type EventRow = Selectable<WhitelistEventsTable>;

/** Etiqueta de un destino agregado por fuera de la plataforma (U+R soberano). */
export const SOVEREIGN_LABEL = 'Agregado con U+R';

const SIGNED_STATUSES: readonly OperationStatus[] = [
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

export interface WhitelistSyncDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  snapshot: () => BackendPolicySnapshot;
  logger: Logger;
  metrics?: Metrics;
}

export interface WhitelistSyncResult {
  requests: number;
  applied: number;
  activated: number;
}

export class WhitelistSync {
  readonly #d: WhitelistSyncDeps;

  constructor(deps: WhitelistSyncDeps) {
    this.#d = deps;
  }

  async runOnce(): Promise<WhitelistSyncResult> {
    const requests = await this.#syncRequests();
    const applied = await this.#applyEvents();
    let activated = 0;
    try {
      activated = await this.#activate();
    } catch (error) {
      if (!(error instanceof RpcQuorumError)) throw error;
      this.#d.logger.warn(
        { code: error.code },
        'activación de whitelist sin quórum: se reintenta en la próxima pasada',
      );
    }
    return { requests, applied, activated };
  }

  /** Estado de los pedidos según su operación WHITELIST_ADD. */
  async #syncRequests(): Promise<number> {
    const rows = await this.#d.db
      .selectFrom('whitelist_requests as r')
      .innerJoin('wallet_operations as o', 'o.id', 'r.operation_id')
      .select(['r.id', 'r.status', 'o.status as op_status', 'o.last_error_code', 'o.failure_reason'])
      .where('r.status', 'in', ['AWAITING_SIGNATURE', 'SUBMITTED'])
      .where('o.status', 'in', [...SIGNED_STATUSES, 'EXPIRED', 'CANCELLED', 'FAILED_FINAL'])
      .limit(500)
      .execute();
    let changed = 0;
    for (const row of rows) {
      let to: 'SUBMITTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | null = null;
      let reason: string | null = null;
      if (row.op_status === 'EXPIRED') [to, reason] = ['EXPIRED', 'NOT_SIGNED_IN_TIME'];
      else if (row.op_status === 'CANCELLED') [to, reason] = ['CANCELLED', 'OPERATION_CANCELLED'];
      else if (row.op_status === 'FAILED_FINAL') [to, reason] = ['FAILED', row.last_error_code ?? row.failure_reason];
      else if (row.status === 'AWAITING_SIGNATURE') to = 'SUBMITTED';
      if (to === null) continue;
      const updated = await this.#d.db
        .updateTable('whitelist_requests')
        .set({ status: to, failure_reason: reason?.slice(0, 200) ?? null })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) changed++;
    }
    return changed;
  }

  async #applyEvents(): Promise<number> {
    const events = await this.#d.db
      .selectFrom('whitelist_events')
      .selectAll()
      .where('applied_at', 'is', null)
      .where('status', 'in', ['CONFIRMED', 'FINALIZED'])
      .orderBy('block_number')
      .orderBy('log_index')
      .limit(200)
      .execute();
    let applied = 0;
    for (const event of events) {
      await withTransaction(
        this.#d.db,
        async (trx) => {
          const claimed = await trx
            .updateTable('whitelist_events')
            .set({ applied_at: new Date() })
            .where('id', '=', event.id)
            .where('applied_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          // Otro worker ya lo aplicó.
          if (!claimed) return;
          if (event.kind === 'ADDED') await this.#added(trx, event);
          else await this.#removed(trx, event);
          applied++;
        },
        { auditLock: true },
      );
    }
    return applied;
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

  /** La operación de la plataforma que ejecutó el evento (misma tx y tipo), si la hubo. */
  async #platformOperation(
    trx: Transaction<Database>,
    walletId: string,
    event: EventRow,
    type: 'WHITELIST_ADD' | 'WHITELIST_REMOVE',
  ) {
    return trx
      .selectFrom('wallet_operations')
      .select(['id', 'owner_role'])
      .where('wallet_id', '=', walletId)
      .where('tx_hash', '=', event.tx_hash)
      .where('operation_type', '=', type)
      .executeTakeFirst();
  }

  async #added(trx: Transaction<Database>, event: EventRow): Promise<void> {
    const wallet = await this.#walletOf(trx, event);
    const destination = bufferToAddress(event.destination);
    const safe = bufferToAddress(event.safe_address);
    const op = await this.#platformOperation(trx, wallet.id, event, 'WHITELIST_ADD');
    const request = op
      ? await trx
          .selectFrom('whitelist_requests')
          .select(['id', 'label'])
          .where('operation_id', '=', op.id)
          .executeTakeFirst()
      : undefined;
    const origin = request ? 'PLATFORM' : 'SOVEREIGN';
    const activatesAt = event.activates_at ?? new Date();
    try {
      await trx
        .insertInto('whitelisted_destinations')
        .values({
          wallet_id: wallet.id,
          destination: event.destination,
          label: request?.label ?? SOVEREIGN_LABEL,
          status: 'ACTIVATING',
          activates_at: activatesAt,
          added_tx_hash: event.tx_hash,
          origin,
          request_id: request?.id ?? null,
        })
        .execute();
    } catch (error) {
      // Ya había un destino vivo para esa dirección (la base estaba desfasada): se deja registrado y se sigue.
      if (sqlState(error) !== '23505') throw error;
      this.#d.logger.warn(
        { walletId: wallet.id, destination },
        'alta on-chain de un destino que la base ya tenía vivo',
      );
      return;
    }
    if (request) {
      await trx
        .updateTable('whitelist_requests')
        .set({ status: 'ACTIVATING', failure_reason: null })
        .where('id', '=', request.id)
        .where('status', 'in', ['AWAITING_SIGNATURE', 'SUBMITTED'])
        .execute();
    } else {
      await notify(
        trx,
        {
          userId: wallet.user_id,
          walletId: wallet.id,
          type: 'WHITELIST_ADDED_SOVEREIGN',
          payload: { destination, safe, activatesAt: activatesAt.toISOString(), txHash: bufferToHex(event.tx_hash) },
          dedupeKey: `WHITELIST_ADDED:${bufferToHex(event.tx_hash)}:${String(event.log_index)}`,
        },
        this.#d.metrics,
      );
    }
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'whitelist-sync',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType: 'WHITELIST_CONFIRMED_ONCHAIN',
      targetType: 'whitelist_request',
      targetId: request?.id ?? null,
      payload: {
        destination,
        origin,
        activatesAt: activatesAt.toISOString(),
        txHash: bufferToHex(event.tx_hash),
        blockNumber: event.block_number,
      },
    });
    this.#d.metrics?.whitelistEvents.inc({ event: 'confirmed_onchain' });
  }

  async #removed(trx: Transaction<Database>, event: EventRow): Promise<void> {
    const wallet = await this.#walletOf(trx, event);
    const destination = bufferToAddress(event.destination);
    const safe = bufferToAddress(event.safe_address);
    const op = await this.#platformOperation(trx, wallet.id, event, 'WHITELIST_REMOVE');
    const removedBy: 'U' | 'R' | 'SAFE' = op?.owner_role ?? 'SAFE';
    const occurredAt = new Date().toISOString();
    const entry = await trx
      .updateTable('whitelisted_destinations')
      .set({ status: 'REMOVED', removed_tx_hash: event.tx_hash, removed_at: new Date(), removed_by: removedBy })
      .where('wallet_id', '=', wallet.id)
      .where('destination', '=', event.destination)
      .where('status', 'in', ['ACTIVATING', 'ACTIVE'])
      .returning(['id', 'label', 'request_id'])
      .executeTakeFirst();
    if (entry?.request_id) {
      await trx
        .updateTable('whitelist_requests')
        .set({ status: 'CANCELLED', failure_reason: 'REMOVED' })
        .where('id', '=', entry.request_id)
        .where('status', '=', 'ACTIVATING')
        .execute();
    }
    const label = entry?.label ?? SOVEREIGN_LABEL;
    const created = await notify(
      trx,
      {
        userId: wallet.user_id,
        walletId: wallet.id,
        type: 'WHITELIST_REMOVED',
        payload: { destination, label, safe, removedBy, txHash: bufferToHex(event.tx_hash), occurredAt },
        dedupeKey: `WHITELIST_REMOVED:${bufferToHex(event.tx_hash)}:${String(event.log_index)}`,
      },
      this.#d.metrics,
    );
    if (created) {
      await this.#d.emails?.enqueue(trx, {
        to: wallet.email,
        template: 'whitelist-removed',
        params: { destination, label, safe, occurredAt, removedBy },
        locale: wallet.locale,
        timeZone: wallet.time_zone,
        product: 'Wallet',
      });
    }
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'whitelist-sync',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType: 'WHITELIST_REMOVED',
      targetType: 'whitelisted_destination',
      targetId: entry?.id ?? null,
      payload: { destination, removedBy, txHash: bufferToHex(event.tx_hash), operationId: op?.id ?? null },
    });
    this.#d.metrics?.whitelistEvents.inc({ event: 'removed' });
  }

  /** ACTIVATING maduros (según el reloj de la cadena) y activos on-chain → ACTIVE. */
  async #activate(): Promise<number> {
    const due = await this.#d.db
      .selectFrom('whitelisted_destinations as d')
      .innerJoin('wallets as w', 'w.id', 'd.wallet_id')
      .select(['d.id', 'd.destination', 'd.activates_at', 'w.safe_address'])
      .where('d.status', '=', 'ACTIVATING')
      .orderBy('d.activates_at')
      .limit(200)
      .execute();
    if (due.length === 0) return 0;
    const whitelist = this.#d.snapshot().contracts.destinationWhitelist;
    const { value: head } = await this.#d.rpc.readSensitive('whitelist-head-timestamp', (client, blockNumber) =>
      client.getBlock({ blockNumber }).then((b) => b.timestamp.toString()),
    );
    const headMs = Number(head) * 1000;
    let activated = 0;
    for (const row of due) {
      if (row.activates_at.getTime() > headMs || row.safe_address === null) continue;
      const safe = bufferToAddress(row.safe_address);
      const destination = bufferToAddress(row.destination);
      const { value: active } = await this.#d.rpc.readSensitive('whitelist-is-whitelisted', (client, blockNumber) =>
        client.readContract({
          address: whitelist,
          abi: destinationWhitelistAbi,
          functionName: 'isWhitelisted',
          args: [safe, destination],
          blockNumber,
        }),
      );
      if (!active) continue;
      if (await this.#markActive(row.id, safe, destination)) activated++;
    }
    return activated;
  }

  async #markActive(entryId: string, safe: Address, destination: Address): Promise<boolean> {
    return withTransaction(
      this.#d.db,
      async (trx) => {
        const entry = await trx
          .updateTable('whitelisted_destinations')
          .set({ status: 'ACTIVE', activated_at: new Date() })
          .where('id', '=', entryId)
          .where('status', '=', 'ACTIVATING')
          .returning(['wallet_id', 'label', 'request_id'])
          .executeTakeFirst();
        if (!entry) return false;
        if (entry.request_id) {
          await trx
            .updateTable('whitelist_requests')
            .set({ status: 'ACTIVE' })
            .where('id', '=', entry.request_id)
            .where('status', '=', 'ACTIVATING')
            .execute();
        }
        const wallet = await trx
          .selectFrom('wallets as w')
          .innerJoin('users as u', 'u.id', 'w.user_id')
          .select(['w.user_id', 'u.email', 'u.locale', 'u.time_zone'])
          .where('w.id', '=', entry.wallet_id)
          .executeTakeFirstOrThrow();
        const occurredAt = new Date().toISOString();
        const created = await notify(
          trx,
          {
            userId: wallet.user_id,
            walletId: entry.wallet_id,
            type: 'WHITELIST_ACTIVATED',
            payload: { destination, label: entry.label, safe, occurredAt },
            dedupeKey: `WHITELIST_ACTIVATED:${entryId}`,
          },
          this.#d.metrics,
        );
        if (created) {
          await this.#d.emails?.enqueue(trx, {
            to: wallet.email,
            template: 'whitelist-activated',
            params: { destination, label: entry.label, safe, occurredAt },
            locale: wallet.locale,
            timeZone: wallet.time_zone,
            product: 'Wallet',
          });
        }
        await this.#d.audit.append(trx, {
          actorType: 'SYSTEM',
          actorId: 'whitelist-sync',
          userId: wallet.user_id,
          walletId: entry.wallet_id,
          eventType: 'WHITELIST_ACTIVATED',
          targetType: 'whitelisted_destination',
          targetId: entryId,
          payload: { destination, safe },
        });
        this.#d.metrics?.whitelistEvents.inc({ event: 'activated' });
        return true;
      },
      { auditLock: true },
    );
  }
}
