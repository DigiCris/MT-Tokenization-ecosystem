// P17.MAN (expand): rechazo del borrador del reemplazo de U por la app Recovery ([F-LNK-04], ESC-41). Si la dirección
// que el usuario copia de la app Wallet no coincide con la U′ del borrador en los intentos de la comparación, Recovery lo
// informa: el borrador queda REJECTED (estado nuevo de rotation_requests) con el motivo y el momento, como un enrollment
// de R rechazado (0009 y 0010), y con qué pasó con su email de seguridad: enviado en el momento, retenido para el resumen
// de la ventana del usuario, incluido en ese resumen o sin email. Sólo se rechaza un borrador de U.
//
// Un estado más en el CHECK y columnas nullable: las filas existentes cumplen los constraints.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE rotation_requests DROP CONSTRAINT rotation_requests_status_check`,
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_status_check
     CHECK (status IN ('DRAFT', 'AWAITING_SIGNATURE', 'PROPOSING', 'PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING',
                       'EXECUTED', 'CANCELLED', 'FAILED', 'REJECTED'))`,
  `ALTER TABLE rotation_requests
     ADD COLUMN rejection_reason text CHECK (rejection_reason IN ('MANUAL_COMPARISON_FAILED')),
     ADD COLUMN rejected_at timestamptz,
     ADD COLUMN rejection_email text CHECK (rejection_email IN ('SENT', 'HELD', 'SUMMARIZED', 'NONE')),
     ADD COLUMN rejection_emailed_at timestamptz`,
  // Rechazada ⇔ con motivo, momento y destino del email, y sólo un borrador de U; con momento del email ⇔ enviado (en el
  // momento o en el resumen).
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_rejection
     CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL)
       AND (rejection_reason IS NULL) = (rejected_at IS NULL)
       AND (rejection_reason IS NULL) = (rejection_email IS NULL)
       AND (rejection_reason IS NULL OR role = 'U')
       AND (rejection_emailed_at IS NOT NULL) = coalesce(rejection_email IN ('SENT', 'SUMMARIZED'), false))`,
  `CREATE INDEX rotation_requests_rejection_held_idx ON rotation_requests (wallet_id) WHERE rejection_email = 'HELD'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
