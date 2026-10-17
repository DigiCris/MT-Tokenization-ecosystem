// Límites transaccionales explícitos (P08.T04). `withTransaction` corre `fn` en una transacción con el nivel de
// aislamiento pedido (SERIALIZABLE por defecto: asignación de nonces y transiciones de estado) y la reintenta ante
// fallas de serialización (40001) o deadlocks (40P01). `fn` puede ejecutarse más de una vez: no debe tener efectos
// fuera de la base (llamadas de red, colas, emails); esos efectos van por el outbox.
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Kysely, type Transaction } from 'kysely';

export type IsolationLevel = 'serializable' | 'repeatable read' | 'read committed';

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Intentos totales (default 6). */
  maxAttempts?: number;
  onRetry?: (attempt: number, sqlState: string) => void;
  /**
   * La transacción escribe en la cadena de auditoría: toma `LOCK TABLE audit_chain_lock IN EXCLUSIVE MODE` como
   * primera sentencia, antes del snapshot (obligatorio en REPEATABLE READ/SERIALIZABLE, ver AuditWriter).
   */
  auditLock?: boolean;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function isRetryable(error: unknown): boolean {
  const state = sqlState(error);
  if (state !== undefined && RETRYABLE_SQLSTATES.has(state)) return true;
  // Cadena de auditoría en REPEATABLE READ/SERIALIZABLE: el snapshot se tomó antes de que otra transacción agregara un
  // evento, así que la cabeza leída quedó vieja y el UNIQUE(prev_hash) rechaza la bifurcación. Reintentar la resuelve.
  return state === '23505' && (error as { constraint?: unknown }).constraint === 'audit_events_prev_hash_key';
}

export class TransactionRetriesExhaustedError extends Error {
  override name = 'TransactionRetriesExhaustedError';
}

export async function withTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolation = options.isolation ?? 'serializable';
  const maxAttempts = options.maxAttempts ?? 6;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel(isolation)
        .execute(async (trx) => {
          if (options.auditLock) await sql`LOCK TABLE audit_chain_lock IN EXCLUSIVE MODE`.execute(trx);
          return fn(trx);
        });
    } catch (error) {
      const state = sqlState(error);
      if (state === undefined || !isRetryable(error)) throw error;
      if (attempt >= maxAttempts) {
        throw new TransactionRetriesExhaustedError(
          `transacción abortada ${maxAttempts} veces por conflicto de serialización (${state})`,
          { cause: error },
        );
      }
      options.onRetry?.(attempt, state);
      // Backoff exponencial con jitter completo: 0–(25 ms × 2^intento), máx. 1 s (≈ 1,5 s de ventana en total): la
      // transacción que ganó el conflicto tiene que llegar a confirmar antes del próximo intento, también con carga.
      await sleep(randomInt(0, Math.min(1_000, 25 * 2 ** attempt) + 1));
    }
  }
}
