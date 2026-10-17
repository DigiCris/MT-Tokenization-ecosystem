// Outbox transaccional [B-Q-01]: el evento se escribe en la misma transacción que el cambio de estado; el dispatcher
// lo publica en BullMQ y el consumidor confirma (processed_at) al terminar.
import { sql, type Kysely, type Transaction } from 'kysely';
import { queueForEvent } from '../../queue/queues.ts';
import type { Database, OutboxEventRow } from '../schema.ts';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export class UnroutedOutboxEventError extends Error {
  override name = 'UnroutedOutboxEventError';
}

export class OutboxRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** Agrega un evento dentro de la transacción del llamador. */
  async enqueue(trx: Transaction<Database>, input: OutboxEventInput): Promise<string> {
    if (queueForEvent(input.eventType) === undefined) {
      throw new UnroutedOutboxEventError(`evento de outbox sin cola asignada: ${input.eventType}`);
    }
    const row = await trx
      .insertInto('outbox_events')
      .values({
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        event_type: input.eventType,
        payload: JSON.stringify(input.payload ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Toma hasta `limit` eventos sin publicar, bloqueándolos (SKIP LOCKED: varios dispatchers no se pisan). */
  async claimUndispatched(trx: Transaction<Database>, limit: number): Promise<OutboxEventRow[]> {
    return trx
      .selectFrom('outbox_events')
      .selectAll()
      .where('dispatched_at', 'is', null)
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
  }

  async markDispatched(trx: Transaction<Database>, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await trx
      .updateTable('outbox_events')
      .set({ dispatched_at: sql`now()`, attempts: sql`attempts + 1`, last_error: null })
      .where('id', 'in', ids)
      .execute();
  }

  async recordDispatchError(trx: Transaction<Database>, id: string, message: string): Promise<void> {
    await trx
      .updateTable('outbox_events')
      .set({ attempts: sql`attempts + 1`, last_error: message.slice(0, 500) })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Confirmación del consumidor (idempotente). El consumidor puede terminar antes de que el dispatcher confirme su
   * transacción: el UPDATE por id espera el lock de la fila y, si esa transacción no llegó a confirmar, marca también
   * dispatched_at (el evento fue entregado y no debe publicarse otra vez). Devuelve false si el evento no existe.
   */
  async markProcessed(eventId: string): Promise<boolean> {
    const result = await this.#db
      .updateTable('outbox_events')
      .set({ processed_at: sql`coalesce(processed_at, now())`, dispatched_at: sql`coalesce(dispatched_at, now())` })
      .where('id', '=', eventId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Publicados y no procesados, en orden de id (paginado por keyset), opcionalmente sólo los publicados antes de `before`. */
  async dispatchedUnprocessed(options: {
    afterId?: string;
    limit: number;
    dispatchedBefore?: Date;
    dispatchedAfter?: Date;
  }): Promise<OutboxEventRow[]> {
    let query = this.#db
      .selectFrom('outbox_events')
      .selectAll()
      .where('processed_at', 'is', null)
      .where('dispatched_at', 'is not', null)
      .orderBy('id', 'asc')
      .limit(options.limit);
    if (options.afterId !== undefined) query = query.where('id', '>', options.afterId);
    if (options.dispatchedBefore) query = query.where('dispatched_at', '<', options.dispatchedBefore);
    if (options.dispatchedAfter) query = query.where('dispatched_at', '>', options.dispatchedAfter);
    return query.execute();
  }

  /** Antigüedad en segundos del evento más viejo sin publicar (0 si no hay). */
  async oldestUndispatchedAgeSeconds(): Promise<number> {
    const row = await sql<{ age: number | null }>`
      SELECT extract(epoch FROM now() - min(created_at))::float8 AS age
      FROM outbox_events WHERE dispatched_at IS NULL`.execute(this.#db);
    return Math.max(0, row.rows[0]?.age ?? 0);
  }
}
