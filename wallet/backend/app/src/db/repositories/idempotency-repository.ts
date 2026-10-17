// Claves de idempotencia (P08.T10) por usuario: el primer request reclama la clave (IN_PROGRESS) y al terminar guarda
// la respuesta (COMPLETED) para repetirla durante 24 h. Mismo key con otro request → conflicto.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.ts';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
/** Un IN_PROGRESS más viejo que esto es de un proceso que murió a mitad del request: se puede retomar. */
export const IDEMPOTENCY_STALE_SECONDS = 120;

export type ClaimResult =
  | { state: 'claimed' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'in-progress' }
  | { state: 'mismatch' };

export class IdempotencyRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async claim(userId: string, key: string, requestHash: Buffer, attempt = 0): Promise<ClaimResult> {
    // Inserta, o retoma una clave vencida o un IN_PROGRESS abandonado (atómico: un solo request gana).
    const claimed = await sql<{ key: string }>`
      INSERT INTO idempotency_keys (user_id, key, request_hash, status, expires_at)
      VALUES (${userId}, ${key}, ${requestHash}, 'IN_PROGRESS', now() + make_interval(secs => ${IDEMPOTENCY_TTL_SECONDS}))
      ON CONFLICT (user_id, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            status = 'IN_PROGRESS',
            response_status = NULL,
            response_body = NULL,
            created_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE idempotency_keys.expires_at <= now()
           OR (idempotency_keys.status = 'IN_PROGRESS'
               AND idempotency_keys.request_hash = EXCLUDED.request_hash
               AND idempotency_keys.created_at < now() - make_interval(secs => ${IDEMPOTENCY_STALE_SECONDS}))
      RETURNING key`.execute(this.#db);
    if (claimed.rows.length > 0) return { state: 'claimed' };

    const existing = await this.#db
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'status', 'response_status', 'response_body'])
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    // La fila se liberó entre el INSERT y la lectura (otro request falló con 5xx): se vuelve a intentar.
    if (!existing) return attempt < 3 ? this.claim(userId, key, requestHash, attempt + 1) : { state: 'in-progress' };
    if (!existing.request_hash.equals(requestHash)) return { state: 'mismatch' };
    if (existing.status === 'IN_PROGRESS' || existing.response_status === null) return { state: 'in-progress' };
    return { state: 'replay', status: existing.response_status, body: existing.response_body };
  }

  async complete(userId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.#db
      .updateTable('idempotency_keys')
      .set({ status: 'COMPLETED', response_status: status, response_body: JSON.stringify(body ?? null) })
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  }

  /** Libera la clave (error 5xx: el cliente puede reintentar con la misma). */
  async release(userId: string, key: string): Promise<void> {
    await this.#db
      .deleteFrom('idempotency_keys')
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  }

  /** Limpieza periódica (worker): borra claves vencidas hace más de un día. */
  async deleteExpired(): Promise<number> {
    const result = await this.#db
      .deleteFrom('idempotency_keys')
      .where('expires_at', '<', sql<Date>`now() - interval '1 day'`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
