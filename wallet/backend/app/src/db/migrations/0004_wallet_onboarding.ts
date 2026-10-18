// P12 (expand): onboarding server-side de la wallet [B-DB]. Columnas nullables y constraints que sólo miran filas en
// los estados nuevos: una versión anterior de la aplicación sigue funcionando.
//
// - wallets: la Safe esperada (CREATE2) se guarda aparte hasta que el deploy se mina (`safe_address` sólo existe con la
//   Safe desplegada), el motivo de un FAILED (verificación post-deploy) y cuándo se pidió el deploy.
// - recovery_metadata: nonce del enrollment (bytes32, el mismo de WalletCreationAuthorization), backups de una R
//   interna, marcas de tiempo, completitud por estado y una sola inscripción viva por wallet y por R.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE wallets
     ADD COLUMN expected_safe eth_address,
     ADD COLUMN failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 200),
     ADD COLUMN deploy_requested_at timestamptz`,
  `CREATE UNIQUE INDEX wallets_chain_expected_safe_key ON wallets (chain_id, expected_safe)
     WHERE expected_safe IS NOT NULL`,

  `ALTER TABLE recovery_metadata
     ADD COLUMN nonce bytes32,
     ADD COLUMN storage_flags jsonb,
     ADD COLUMN submitted_at timestamptz,
     ADD COLUMN confirmed_at timestamptz`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_submitted_complete
     CHECK (status NOT IN ('SUBMITTED', 'CONFIRMED') OR (
       r_address IS NOT NULL AND r_type IS NOT NULL AND nonce IS NOT NULL AND enrollment_key_jwk IS NOT NULL
       AND enrollment_payload IS NOT NULL AND enrollment_key_signature IS NOT NULL
       AND r_proof_signature IS NOT NULL AND submitted_at IS NOT NULL))`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_confirmed_complete
     CHECK (status <> 'CONFIRMED' OR (u_incorporation_signature IS NOT NULL AND confirmed_at IS NOT NULL))`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_external_connector
     CHECK (r_type IS DISTINCT FROM 'EXTERNAL' OR connector_id IS NOT NULL)`,
  `CREATE UNIQUE INDEX recovery_metadata_wallet_live_key ON recovery_metadata (wallet_id)
     WHERE status IN ('SUBMITTED', 'CONFIRMED')`,
  `CREATE UNIQUE INDEX recovery_metadata_r_live_key ON recovery_metadata (r_address)
     WHERE status IN ('SUBMITTED', 'CONFIRMED')`,
  `CREATE INDEX recovery_metadata_wallet_created_idx ON recovery_metadata (wallet_id, created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
