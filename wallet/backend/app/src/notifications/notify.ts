// Notificaciones in-app ([B-MAIL-03]): una fila en `notifications` dentro de la transacción del cambio que la origina.
// Con `dedupeKey` la notificación es única por evento aunque la detecten varios workers o reintentos: si ya existe no
// se inserta otra y el llamador no repite el email que la acompaña.
import type { Transaction } from 'kysely';
import type { Database } from '../db/schema.ts';
import type { Metrics } from '../observability/metrics.ts';

export interface NotificationInput {
  userId: string;
  walletId: string | null;
  /** `^[A-Z][A-Z0-9_]{2,63}$` (CHECK de la tabla). */
  type: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** true si se creó (false: ya existía una con la misma clave de deduplicación). */
export async function notify(
  trx: Transaction<Database>,
  input: NotificationInput,
  metrics?: Metrics,
): Promise<boolean> {
  const row = await trx
    .insertInto('notifications')
    .values({
      user_id: input.userId,
      wallet_id: input.walletId,
      type: input.type,
      payload: JSON.stringify(input.payload),
      dedupe_key: input.dedupeKey ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (row) metrics?.notificationsCreated.inc({ type: input.type });
  return row !== undefined;
}
