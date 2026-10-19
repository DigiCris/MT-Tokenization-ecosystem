// P17.MAN (expand): correcciones de la revisión de seguridad de ADR-033.
//
// - rotation_events: cuarentena por evento. Un evento que no se puede aplicar (p. ej. un efecto que viola un constraint)
//   ya no frena la sincronización de todas las wallets: queda en cuarentena con el error, los intentos y cuándo se
//   reintenta (espera exponencial), y los eventos posteriores de su misma Safe esperan detrás de él (el orden por Safe no
//   se pierde). Al aplicarse sale de la cuarentena.
// - recovery_metadata: cuándo llegó el aviso del rechazo de la Wallet (un pedido reemplazado conserva en `rejected_at`
//   cuándo se lo reemplazó) y qué pasó con su email de seguridad: enviado en el momento, retenido para el resumen de la
//   ventana del usuario (un email por ventana), incluido en ese resumen, o sin email (un reemplazo viejo o sin
//   proveedor). Los avisos anteriores a 0010 se enviaron cuando se rechazaron.
//
// Columnas nullable o con default: las filas existentes cumplen los constraints (con el backfill de los avisos).
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE rotation_events
     ADD COLUMN apply_attempts integer NOT NULL DEFAULT 0 CHECK (apply_attempts >= 0),
     ADD COLUMN apply_error text CHECK (apply_error IS NULL OR length(apply_error) <= 500),
     ADD COLUMN quarantined_at timestamptz,
     ADD COLUMN retry_at timestamptz`,
  // En cuarentena ⇔ con próximo intento; un evento aplicado ya no está en cuarentena.
  `ALTER TABLE rotation_events ADD CONSTRAINT rotation_events_quarantine
     CHECK ((quarantined_at IS NULL) = (retry_at IS NULL) AND (applied_at IS NULL OR quarantined_at IS NULL))`,
  `CREATE INDEX rotation_events_quarantined_idx ON rotation_events (chain_id, safe_address)
     WHERE quarantined_at IS NOT NULL`,

  `ALTER TABLE recovery_metadata
     ADD COLUMN rejection_reported_at timestamptz,
     ADD COLUMN rejection_email text CHECK (rejection_email IN ('SENT', 'HELD', 'SUMMARIZED', 'NONE')),
     ADD COLUMN rejection_emailed_at timestamptz`,
  `UPDATE recovery_metadata
     SET rejection_reported_at = rejected_at, rejection_email = 'SENT', rejection_emailed_at = rejected_at
     WHERE rejection_reason IN ('MANUAL_COMPARISON_FAILED', 'RETURN_LINK_KEY_MISMATCH', 'RETURN_LINK_UNVERIFIED')`,
  // Con aviso ⇔ con destino del email; con momento del email ⇔ enviado (en el momento o en el resumen).
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_rejection_email
     CHECK ((rejection_reported_at IS NULL) = (rejection_email IS NULL)
       AND (rejection_emailed_at IS NOT NULL) = coalesce(rejection_email IN ('SENT', 'SUMMARIZED'), false))`,
  `CREATE INDEX recovery_metadata_rejection_held_idx ON recovery_metadata (wallet_id) WHERE rejection_email = 'HELD'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
