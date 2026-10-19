// P17.MAN (expand): motivo del rechazo de un enrollment de R (hallazgo N10 de la segunda revisión del onboarding). La
// Wallet informa por qué abortó un pedido —la comparación manual no coincidió en sus intentos, el enlace de regreso trae
// otra R o es un enlace que no armó la app Recovery del usuario ([F-LNK-02])— y el pedido queda REJECTED con el motivo
// y el momento; uno reemplazado por un pedido nuevo queda REJECTED con SUPERSEDED. Columnas nullable: las filas
// existentes (REJECTED sin motivo) ya cumplen los constraints.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE recovery_metadata
     ADD COLUMN rejection_reason text CHECK (rejection_reason IN (
       'SUPERSEDED', 'MANUAL_COMPARISON_FAILED', 'RETURN_LINK_KEY_MISMATCH', 'RETURN_LINK_UNVERIFIED')),
     ADD COLUMN rejected_at timestamptz`,
  // El motivo y el momento sólo existen en un pedido rechazado.
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_rejection_status
     CHECK (status = 'REJECTED' OR (rejection_reason IS NULL AND rejected_at IS NULL))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
