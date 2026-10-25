// Tope de los emails de seguridad de los rechazos (revisión de seguridad de ADR-033, BAJO 8). Cada aviso de rechazo
// deja su auditoría, su notificación in-app, la alerta y la métrica, pero el email sale uno por ventana y usuario para
// cada tipo de rechazo: el de un enrollment de R que rechazó la Wallet ([F-LNK-02]) y el de un borrador del reemplazo de
// U que rechazó la app Recovery ([F-LNK-04]). El primero de la ventana sale en el momento (SENT) y los siguientes quedan
// retenidos (HELD) para el resumen que manda el worker al cerrarla (rejection-digest.ts). Sin carreras: el rechazo y el
// resumen toman el lock de auditoría.
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/schema.ts';

/** Un email de seguridad de rechazo por usuario y tipo en esta ventana; los demás van juntos en el resumen al cerrarla. */
export const REJECTION_EMAIL_WINDOW_MS = 60 * 60_000;

/** Tipo de rechazo: cada uno tiene su propia ventana y su propio resumen. */
export type RejectionSource = 'R_ENROLLMENT' | 'U_REPLACEMENT';

/** Cuándo salió el último email de rechazo de ese tipo para el usuario (en el momento o en un resumen); null si nunca. */
export async function lastRejectionEmail(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
  source: RejectionSource,
): Promise<Date | null> {
  if (source === 'R_ENROLLMENT') {
    const row = await db
      .selectFrom('recovery_metadata as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .select((eb) => eb.fn.max('r.rejection_emailed_at').as('last'))
      .where('w.user_id', '=', userId)
      .where('r.rejection_emailed_at', 'is not', null)
      .executeTakeFirst();
    return row?.last ?? null;
  }
  const row = await db
    .selectFrom('rotation_requests as r')
    .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
    .select((eb) => eb.fn.max('r.rejection_emailed_at').as('last'))
    .where('w.user_id', '=', userId)
    .where('r.rejection_emailed_at', 'is not', null)
    .executeTakeFirst();
  return row?.last ?? null;
}

/**
 * El email de un rechazo nuevo: SENT si en la ventana no salió ninguno de ese tipo (en el momento o en un resumen); si
 * no, HELD y lo manda el resumen al cerrar la ventana. Se llama con el lock de auditoría tomado.
 */
export async function rejectionEmailSlot(
  trx: Transaction<Database>,
  userId: string,
  now: number,
  source: RejectionSource,
): Promise<'SENT' | 'HELD'> {
  const last = await lastRejectionEmail(trx, userId, source);
  return last !== null && now - last.getTime() < REJECTION_EMAIL_WINDOW_MS ? 'HELD' : 'SENT';
}
