// P13 (expand): pipeline de operaciones [B-SM], [B-NONCE], [B-Q], [B-FIN]. Columnas nullables (o con default) y
// constraints que sólo miran filas en los estados nuevos: una versión anterior de la aplicación sigue funcionando.
//
// - wallet_operations: vencimiento de las CREATED (15 min sin firma), bloqueo por nonce menor pendiente
//   ([B-NONCE-03]), envelope de envío completo (firma de la session key, token de la PlatformSession y atestación del
//   challenge, que el signer vuelve a verificar por su cuenta), 2FA exigido, momento de la firma y, en una NOOP_CANCEL,
//   la operación que cancela ([B-NONCE-06]).
// - wallets: deriva de configuración de la Safe detectada (SOVEREIGN_MODIFIED, P13.T11).
// - chain_transactions: índice de las tx no finalizadas que sigue el watcher.
// - safe_executions: ejecuciones de la Safe indexadas desde los eventos de SafeL2 (las del backend y las soberanas).
// - token_transfers: momento del último cambio de estado (watcher/indexer).
// - chain_cursors: último bloque procesado por cada indexer (con su hash, para detectar reorgs).
// - audit_events: historial de una operación por destino (target_type, target_id), que además usa el constraint
//   trigger que rechaza toda transición de estado sin su evento de auditoría ([B-SM-02], P13.SEC).
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const JWS = `'^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$'`;

const STATEMENTS = [
  `ALTER TABLE wallet_operations
     ADD COLUMN expires_at timestamptz,
     ADD COLUMN blocked_reason text CHECK (blocked_reason IS NULL OR blocked_reason IN ('WAITING_LOWER_NONCE')),
     ADD COLUMN submission_envelope_signature text
       CHECK (submission_envelope_signature IS NULL OR submission_envelope_signature ~ '^[A-Za-z0-9_-]{86}$'),
     ADD COLUMN platform_session_token text
       CHECK (platform_session_token IS NULL OR (length(platform_session_token) <= 8192 AND platform_session_token ~ ${JWS})),
     ADD COLUMN challenge_attestation text
       CHECK (challenge_attestation IS NULL OR (length(challenge_attestation) <= 8192 AND challenge_attestation ~ ${JWS})),
     ADD COLUMN requires_two_factor boolean NOT NULL DEFAULT false,
     ADD COLUMN signed_at timestamptz,
     ADD COLUMN cancels_operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT`,
  `ALTER TABLE wallet_operations ADD CONSTRAINT wallet_operations_created_expiry
     CHECK (status <> 'CREATED' OR expires_at IS NOT NULL)`,
  // Una firma aceptada siempre viene con su envelope verificado y la sesión que la envió [B-PSES-06].
  `ALTER TABLE wallet_operations ADD CONSTRAINT wallet_operations_submission_complete
     CHECK (owner_signature IS NULL OR (submission_envelope IS NOT NULL AND submission_envelope_signature IS NOT NULL
       AND platform_session_token IS NOT NULL AND platform_session_id IS NOT NULL AND signed_at IS NOT NULL))`,
  `ALTER TABLE wallet_operations ADD CONSTRAINT wallet_operations_cancels_noop
     CHECK (cancels_operation_id IS NULL OR operation_type = 'NOOP_CANCEL')`,
  `ALTER TABLE wallet_operations ADD CONSTRAINT wallet_operations_blocked_queued
     CHECK (blocked_reason IS NULL OR status IN ('QUEUED', 'FAILED_RETRYABLE'))`,
  `CREATE INDEX wallet_operations_wallet_nonce_idx ON wallet_operations (wallet_id, safe_nonce)`,
  // Cambio respecto de [B-DB] (UNIQUE(safe_tx_hash)): la misma SafeTx (mismo nonce y contenido) se puede volver a
  // preparar cuando la anterior venció, se canceló o falló en forma definitiva; viva hay a lo sumo una.
  `ALTER TABLE wallet_operations DROP CONSTRAINT wallet_operations_safe_tx_hash_key`,
  `CREATE UNIQUE INDEX wallet_operations_live_safe_tx_hash_key ON wallet_operations (safe_tx_hash)
     WHERE status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED_FINAL')`,
  `CREATE INDEX wallet_operations_safe_tx_hash_idx ON wallet_operations (safe_tx_hash)`,
  `CREATE INDEX wallet_operations_created_expiry_idx ON wallet_operations (expires_at) WHERE status = 'CREATED'`,

  `ALTER TABLE wallets
     ADD COLUMN config_drift jsonb,
     ADD COLUMN config_drift_at timestamptz`,
  `ALTER TABLE wallets ADD CONSTRAINT wallets_sovereign_modified_drift
     CHECK (status <> 'SOVEREIGN_MODIFIED' OR (config_drift IS NOT NULL AND config_drift_at IS NOT NULL))`,

  `CREATE INDEX chain_transactions_pending_idx ON chain_transactions (status, created_at)
     WHERE status IN ('BROADCAST', 'MINED', 'CONFIRMED')`,
  `CREATE INDEX chain_transactions_from_nonce_idx ON chain_transactions (chain_id, from_address, account_nonce)`,

  `CREATE TABLE safe_executions (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     safe_address eth_address NOT NULL,
     safe_nonce uint256 NOT NULL,
     safe_tx_hash bytes32 NOT NULL,
     success boolean NOT NULL,
     origin text NOT NULL CHECK (origin IN ('PLATFORM', 'SOVEREIGN')),
     operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT,
     target eth_address NOT NULL,
     value uint256 NOT NULL,
     data bytea NOT NULL,
     operation smallint NOT NULL CHECK (operation IN (0, 1)),
     sender eth_address NOT NULL,
     tx_hash bytes32 NOT NULL,
     log_index integer NOT NULL CHECK (log_index >= 0),
     block_number bigint NOT NULL CHECK (block_number >= 0),
     block_hash bytes32 NOT NULL,
     status text NOT NULL CHECK (status IN ('MINED', 'CONFIRMED', 'FINALIZED', 'REORGED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT safe_executions_log_key UNIQUE (chain_id, tx_hash, log_index),
     CONSTRAINT safe_executions_origin_operation CHECK (origin = 'SOVEREIGN' OR operation_id IS NOT NULL),
     CONSTRAINT safe_executions_wallet_fk FOREIGN KEY (chain_id, safe_address)
       REFERENCES wallets (chain_id, safe_address) ON DELETE RESTRICT
   )`,
  `CREATE INDEX safe_executions_safe_block_idx ON safe_executions (chain_id, safe_address, block_number DESC)`,
  `CREATE INDEX safe_executions_pending_idx ON safe_executions (status) WHERE status IN ('MINED', 'CONFIRMED')`,

  `ALTER TABLE token_transfers ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE INDEX token_transfers_pending_idx ON token_transfers (status) WHERE status IN ('MINED', 'CONFIRMED')`,

  `CREATE TABLE chain_cursors (
     name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9:-]{1,62}$'),
     block_number bigint NOT NULL CHECK (block_number >= 0),
     block_hash bytes32 NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, id)`,

  // [B-SM-02] en la base: un cambio de estado de wallet_operations sin su evento OPERATION_<ESTADO> en la misma
  // transacción se rechaza al confirmar (constraint trigger diferido; xmin de la fila de auditoría = transacción actual).
  `CREATE FUNCTION wallet_operations_transition_audited() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM audit_events
       WHERE target_type = 'operation' AND target_id = NEW.id::text
         AND event_type = 'OPERATION_' || NEW.status
         AND xmin = pg_current_xact_id()::xid
     ) THEN
       RAISE EXCEPTION 'transición de wallet_operations % -> % sin auditoría', OLD.status, NEW.status
         USING ERRCODE = 'check_violation';
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER wallet_operations_transition_audited
     AFTER UPDATE OF status ON wallet_operations
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
     EXECUTE FUNCTION wallet_operations_transition_audited()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
