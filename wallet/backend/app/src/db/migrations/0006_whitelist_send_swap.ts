// P14 (expand): whitelist, send y swap. Columnas nullables (o con default) y tablas nuevas: una versión anterior de la
// aplicación sigue funcionando. `operation_groups` recibe columnas NOT NULL porque ninguna versión anterior creó grupos.
//
// - whitelist_requests: motivo de una falla y momento en que se superó el challenge (ventana para reintentar el
//   prepare de la SafeTx sin pedir otro código si falló por un error transitorio).
// - whitelisted_destinations: origen (PLATFORM, o SOVEREIGN: alta U+R por fuera de la plataforma), pedido que la
//   originó, activación y baja (quién la hizo); cada evento on-chain se aplica una sola vez (tx de alta y de baja
//   únicas).
// - whitelist_events: eventos DestinationAdded/DestinationRemoved de DestinationWhitelist para las Safes de la
//   plataforma (los indexa el indexer con la misma finalidad y manejo de reorgs que las ejecuciones; los aplica la
//   sincronización de whitelist del worker cuando están confirmados).
// - operation_groups: usuario, par y monto del swap, cotización vigente, motivo de una falla, cuándo se completó y
//   cuándo se notificó una allowance residual.
// - notifications: clave de deduplicación (una sola notificación por evento aunque corran varios workers).
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE whitelist_requests
     ADD COLUMN failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
     ADD COLUMN challenge_passed_at timestamptz`,
  // Filas anteriores (ninguna versión previa crea pedidos, pero la migración no debe depender de eso).
  `UPDATE whitelist_requests SET challenge_passed_at = updated_at
     WHERE status IN ('CHALLENGE_PASSED', 'AWAITING_SIGNATURE', 'SUBMITTED', 'ACTIVATING', 'ACTIVE')
       AND challenge_passed_at IS NULL`,
  `UPDATE whitelist_requests SET status = 'FAILED', failure_reason = 'MIGRATION_WITHOUT_OPERATION'
     WHERE status IN ('AWAITING_SIGNATURE', 'SUBMITTED', 'ACTIVATING', 'ACTIVE') AND operation_id IS NULL`,
  `ALTER TABLE whitelist_requests ADD CONSTRAINT whitelist_requests_challenge_passed
     CHECK (status NOT IN ('CHALLENGE_PASSED', 'AWAITING_SIGNATURE', 'SUBMITTED', 'ACTIVATING', 'ACTIVE')
            OR challenge_passed_at IS NOT NULL)`,
  `ALTER TABLE whitelist_requests ADD CONSTRAINT whitelist_requests_operation
     CHECK (status NOT IN ('AWAITING_SIGNATURE', 'SUBMITTED', 'ACTIVATING', 'ACTIVE') OR operation_id IS NOT NULL)`,
  `CREATE INDEX whitelist_requests_wallet_idx ON whitelist_requests (wallet_id, created_at DESC)`,
  `CREATE INDEX whitelist_requests_operation_idx ON whitelist_requests (operation_id) WHERE operation_id IS NOT NULL`,

  `ALTER TABLE whitelisted_destinations
     ADD COLUMN origin text NOT NULL DEFAULT 'PLATFORM' CHECK (origin IN ('PLATFORM', 'SOVEREIGN')),
     ADD COLUMN request_id uuid REFERENCES whitelist_requests (id) ON DELETE RESTRICT,
     ADD COLUMN activated_at timestamptz,
     ADD COLUMN removed_at timestamptz,
     ADD COLUMN removed_by text CHECK (removed_by IS NULL OR removed_by IN ('U', 'R', 'SAFE'))`,
  // Filas anteriores (ninguna versión previa crea destinos, pero la migración no debe depender de eso).
  `UPDATE whitelisted_destinations SET activated_at = activates_at WHERE status = 'ACTIVE' AND activated_at IS NULL`,
  `UPDATE whitelisted_destinations SET removed_at = updated_at, removed_by = 'SAFE'
     WHERE status = 'REMOVED' AND removed_at IS NULL`,
  `ALTER TABLE whitelisted_destinations ADD CONSTRAINT whitelisted_destinations_active
     CHECK (status <> 'ACTIVE' OR activated_at IS NOT NULL)`,
  `ALTER TABLE whitelisted_destinations ADD CONSTRAINT whitelisted_destinations_removed
     CHECK (status <> 'REMOVED' OR (removed_at IS NOT NULL AND removed_by IS NOT NULL))`,
  `CREATE UNIQUE INDEX whitelisted_destinations_added_tx_key ON whitelisted_destinations (added_tx_hash)
     WHERE added_tx_hash IS NOT NULL`,
  `CREATE UNIQUE INDEX whitelisted_destinations_removed_tx_key ON whitelisted_destinations (removed_tx_hash)
     WHERE removed_tx_hash IS NOT NULL`,
  `CREATE INDEX whitelisted_destinations_activating_idx ON whitelisted_destinations (activates_at)
     WHERE status = 'ACTIVATING'`,

  `CREATE TABLE whitelist_events (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     safe_address eth_address NOT NULL,
     destination eth_address NOT NULL,
     kind text NOT NULL CHECK (kind IN ('ADDED', 'REMOVED')),
     activates_at timestamptz,
     tx_hash bytes32 NOT NULL,
     log_index integer NOT NULL CHECK (log_index >= 0),
     block_number bigint NOT NULL CHECK (block_number >= 0),
     block_hash bytes32 NOT NULL,
     status text NOT NULL CHECK (status IN ('MINED', 'CONFIRMED', 'FINALIZED', 'REORGED')),
     applied_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT whitelist_events_log_key UNIQUE (chain_id, tx_hash, log_index),
     CONSTRAINT whitelist_events_activation CHECK ((kind = 'ADDED') = (activates_at IS NOT NULL)),
     CONSTRAINT whitelist_events_wallet_fk FOREIGN KEY (chain_id, safe_address)
       REFERENCES wallets (chain_id, safe_address) ON DELETE RESTRICT
   )`,
  `CREATE TRIGGER whitelist_events_set_updated_at BEFORE UPDATE ON whitelist_events
     FOR EACH ROW EXECUTE FUNCTION mtw_set_updated_at()`,
  `CREATE INDEX whitelist_events_pending_idx ON whitelist_events (status) WHERE status IN ('MINED', 'CONFIRMED')`,
  `CREATE INDEX whitelist_events_unapplied_idx ON whitelist_events (block_number, log_index)
     WHERE applied_at IS NULL AND status IN ('CONFIRMED', 'FINALIZED')`,

  `ALTER TABLE operation_groups
     ADD COLUMN user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     ADD COLUMN token_in eth_address NOT NULL,
     ADD COLUMN token_out eth_address NOT NULL,
     ADD COLUMN amount_in uint256 NOT NULL CHECK (amount_in > 0),
     ADD COLUMN quote jsonb NOT NULL,
     ADD COLUMN failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
     ADD COLUMN completed_at timestamptz,
     ADD COLUMN allowance_notified_at timestamptz`,
  `ALTER TABLE operation_groups ADD CONSTRAINT operation_groups_pair CHECK (token_in <> token_out)`,
  `ALTER TABLE operation_groups ADD CONSTRAINT operation_groups_completed
     CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)`,
  `CREATE INDEX operation_groups_wallet_idx ON operation_groups (wallet_id, created_at DESC)`,
  `CREATE INDEX operation_groups_open_idx ON operation_groups (status) WHERE status IN ('OPEN', 'FAILED')`,
  `CREATE INDEX wallet_operations_group_idx ON wallet_operations (group_id, safe_nonce) WHERE group_id IS NOT NULL`,

  `ALTER TABLE notifications ADD COLUMN dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 200)`,
  `CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
