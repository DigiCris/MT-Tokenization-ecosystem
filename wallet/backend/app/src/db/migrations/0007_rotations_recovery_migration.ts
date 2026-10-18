// P15 (expand): rotaciones, recovery, migración excepcional y notificaciones. Columnas nullables (o con default),
// tablas nuevas y constraints relajados o reemplazados por otros que las filas existentes ya cumplen.
//
// - rotation_requests: el RotationTimelock de la propuesta (el del Guard que gobernaba la Safe: tras un upgrade, el del
//   sucesor), rotación de GUARD/MODULE_GUARD (upgrade del Guard), origen (PLATFORM o ONCHAIN: propuesta que
//   no originó el backend, detectada por el indexer), propuesta iniciada por la propia Safe, material de la clave
//   nueva que el signer vuelve a verificar (KeyAcceptance de U'/R', SignerKeyAttestation de S'), el registro OPAQUE
//   pendiente de U' y el enrollment de R', y los momentos y tx de propuesta y ejecución.
// - rotation_events: eventos de RotationTimelock (propuesta, cancelación, ejecución) de las Safes de la plataforma,
//   indexados con finalidad y reorgs y aplicados una vez por la sincronización de rotaciones del worker.
// - recovery_metadata: enrollment de reemplazo de R (R' de una wallet ACTIVE, con su KeyAcceptance); una R
//   reemplazada queda RETIRED. La unicidad "una viva por wallet" pasa a ser por estado (una CONFIRMED y una SUBMITTED),
//   y la R sana que reutiliza la Safe nueva de una migración excepcional (`reused_from_wallet_id`) puede estar viva en
//   las dos wallets.
// - wallet_keys_metadata: la credencial sana reutilizada por la Safe nueva de una migración excepcional
//   (`reused_from_wallet_id`) puede estar viva en las dos wallets mientras dura la migración.
// - migration_cases: caso de migración excepcional (doble aprobación de operadores en operator_actions).
// - signer_keys: cuándo la S dejó de ser la de la Safe y cuándo el shard confirmó su retiro ([B-SIG-08]).
// - operator_users: último paso TOTP usado por cada operador (anti-replay, como el 2FA de los usuarios).
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const JWS = `'^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$'`;

const STATEMENTS = [
  `ALTER TABLE rotation_requests DROP CONSTRAINT rotation_requests_role_check`,
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_role_check
     CHECK (role IN ('U', 'R', 'S', 'GUARD', 'MODULE_GUARD'))`,
  `ALTER TABLE rotation_requests DROP CONSTRAINT rotation_requests_initiated_by_check`,
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_initiated_by_check
     CHECK (initiated_by IN ('U', 'R', 'SAFE'))`,
  `ALTER TABLE rotation_requests
     ADD COLUMN origin text NOT NULL DEFAULT 'PLATFORM' CHECK (origin IN ('PLATFORM', 'ONCHAIN')),
     ADD COLUMN key_acceptance jsonb,
     ADD COLUMN new_key_attestation text
       CHECK (new_key_attestation IS NULL OR (length(new_key_attestation) <= 8192 AND new_key_attestation ~ ${JWS})),
     ADD COLUMN opaque_record_id uuid REFERENCES opaque_records (id) ON DELETE RESTRICT,
     ADD COLUMN enrollment_id uuid REFERENCES recovery_metadata (id) ON DELETE RESTRICT,
     ADD COLUMN proposed_at timestamptz,
     ADD COLUMN executed_at timestamptz,
     ADD COLUMN propose_tx_hash bytes32,
     ADD COLUMN execute_tx_hash bytes32,
     ADD COLUMN failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
     ADD COLUMN timelock eth_address`,
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_proposed
     CHECK (status NOT IN ('PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING', 'EXECUTED')
            OR (proposal_id IS NOT NULL AND executable_at IS NOT NULL))`,
  `CREATE UNIQUE INDEX rotation_requests_proposal_key ON rotation_requests (proposal_id) WHERE proposal_id IS NOT NULL`,
  `CREATE INDEX rotation_requests_wallet_idx ON rotation_requests (wallet_id, created_at DESC)`,
  `CREATE INDEX rotation_requests_operations_idx ON rotation_requests (propose_operation_id, execute_operation_id)`,

  `CREATE TABLE rotation_events (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     safe_address eth_address NOT NULL,
     timelock eth_address NOT NULL,
     proposal_id bytes32 NOT NULL,
     kind text NOT NULL CHECK (kind IN ('PROPOSED', 'CANCELLED', 'EXECUTED')),
     rotation_kind smallint CHECK (rotation_kind BETWEEN 0 AND 4),
     old_value eth_address,
     new_value eth_address,
     executable_at timestamptz,
     actor eth_address,
     tx_hash bytes32 NOT NULL,
     log_index integer NOT NULL CHECK (log_index >= 0),
     block_number bigint NOT NULL CHECK (block_number >= 0),
     block_hash bytes32 NOT NULL,
     status text NOT NULL CHECK (status IN ('MINED', 'CONFIRMED', 'FINALIZED', 'REORGED')),
     applied_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT rotation_events_log_key UNIQUE (chain_id, tx_hash, log_index),
     CONSTRAINT rotation_events_proposed CHECK (kind <> 'PROPOSED' OR (rotation_kind IS NOT NULL
       AND old_value IS NOT NULL AND new_value IS NOT NULL AND executable_at IS NOT NULL)),
     CONSTRAINT rotation_events_cancelled CHECK (kind <> 'CANCELLED' OR actor IS NOT NULL),
     CONSTRAINT rotation_events_wallet_fk FOREIGN KEY (chain_id, safe_address)
       REFERENCES wallets (chain_id, safe_address) ON DELETE RESTRICT
   )`,
  `CREATE TRIGGER rotation_events_set_updated_at BEFORE UPDATE ON rotation_events
     FOR EACH ROW EXECUTE FUNCTION mtw_set_updated_at()`,
  `CREATE INDEX rotation_events_pending_idx ON rotation_events (status) WHERE status IN ('MINED', 'CONFIRMED')`,
  `CREATE INDEX rotation_events_unapplied_idx ON rotation_events (block_number, log_index)
     WHERE applied_at IS NULL AND status IN ('CONFIRMED', 'FINALIZED')`,

  `ALTER TABLE recovery_metadata
     ADD COLUMN purpose text NOT NULL DEFAULT 'ONBOARDING' CHECK (purpose IN ('ONBOARDING', 'REPLACEMENT')),
     ADD COLUMN key_acceptance jsonb,
     ADD COLUMN retired_at timestamptz,
     ADD COLUMN reused_from_wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT`,
  `DROP INDEX recovery_metadata_r_live_key`,
  `CREATE UNIQUE INDEX recovery_metadata_r_live_key ON recovery_metadata (r_address)
     WHERE status IN ('SUBMITTED', 'CONFIRMED') AND reused_from_wallet_id IS NULL`,
  `ALTER TABLE recovery_metadata DROP CONSTRAINT recovery_metadata_status_check`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_status_check
     CHECK (status IN ('REQUESTED', 'SUBMITTED', 'CONFIRMED', 'EXPIRED', 'REJECTED', 'RETIRED'))`,
  // La autorización de creación firmada por U sólo existe en el enrollment del onboarding; el de reemplazo queda
  // confirmado por la rotación ejecutada on-chain.
  `ALTER TABLE recovery_metadata DROP CONSTRAINT recovery_metadata_confirmed_complete`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_confirmed_complete
     CHECK (status <> 'CONFIRMED' OR (confirmed_at IS NOT NULL
       AND (purpose = 'REPLACEMENT' OR u_incorporation_signature IS NOT NULL)))`,
  `ALTER TABLE recovery_metadata ADD CONSTRAINT recovery_metadata_retired
     CHECK (status <> 'RETIRED' OR retired_at IS NOT NULL)`,
  `DROP INDEX recovery_metadata_wallet_live_key`,
  `CREATE UNIQUE INDEX recovery_metadata_wallet_confirmed_key ON recovery_metadata (wallet_id) WHERE status = 'CONFIRMED'`,
  `CREATE UNIQUE INDEX recovery_metadata_wallet_submitted_key ON recovery_metadata (wallet_id) WHERE status = 'SUBMITTED'`,

  `ALTER TABLE wallet_keys_metadata
     ADD COLUMN reused_from_wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT`,
  `DROP INDEX wallet_keys_live_address_key`,
  `CREATE UNIQUE INDEX wallet_keys_live_address_key ON wallet_keys_metadata (key_address)
     WHERE status IN ('PENDING', 'ACTIVE') AND reused_from_wallet_id IS NULL`,

  `ALTER TABLE signer_keys ADD COLUMN retired_at timestamptz, ADD COLUMN signer_retired_at timestamptz`,
  `ALTER TABLE operator_users ADD COLUMN totp_last_used_step bigint CHECK (totp_last_used_step IS NULL OR totp_last_used_step >= 0)`,
  `CREATE INDEX signer_keys_retire_pending_idx ON signer_keys (created_at)
     WHERE status = 'RETIRED' AND signer_retired_at IS NULL`,

  `CREATE TABLE migration_cases (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     old_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     new_wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     healthy_role text NOT NULL CHECK (healthy_role IN ('U', 'R')),
     reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
     status text NOT NULL CHECK (status IN ('REQUESTED', 'APPROVED', 'COMPLETED', 'CANCELLED')),
     requested_by uuid NOT NULL REFERENCES operator_users (id) ON DELETE RESTRICT,
     approval_action_id uuid REFERENCES operator_actions (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     completed_at timestamptz,
     CONSTRAINT migration_cases_approved CHECK (status IN ('REQUESTED', 'CANCELLED') OR approval_action_id IS NOT NULL),
     CONSTRAINT migration_cases_completed CHECK (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND new_wallet_id IS NOT NULL)),
     CONSTRAINT migration_cases_distinct_wallets CHECK (new_wallet_id IS NULL OR new_wallet_id <> old_wallet_id)
   )`,
  `CREATE TRIGGER migration_cases_set_updated_at BEFORE UPDATE ON migration_cases
     FOR EACH ROW EXECUTE FUNCTION mtw_set_updated_at()`,
  `CREATE UNIQUE INDEX migration_cases_open_key ON migration_cases (old_wallet_id)
     WHERE status IN ('REQUESTED', 'APPROVED')`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
