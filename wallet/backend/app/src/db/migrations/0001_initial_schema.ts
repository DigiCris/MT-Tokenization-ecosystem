// Migración inicial [B-DB]: todas las tablas del modelo de datos, con FKs explícitas ON DELETE RESTRICT [B-DB-FK],
// índices únicos parciales, CHECKs, trigger append-only de audit_events y operator_actions, y GRANTs por rol
// [B-DB-ROLES]. Patrón expand/contract: no hay "down"; una versión anterior de la aplicación sigue funcionando sobre
// este esquema.
import { sql, type Kysely } from 'kysely';
import { grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  // Roles creados por la infraestructura (infra/local/postgres/init-db.sh; producción: scripts/deploy, P26).
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtw_app') THEN
       RAISE EXCEPTION 'falta el rol mtw_app (ver infra/local/postgres/init-db.sh)';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtw_readonly') THEN
       RAISE EXCEPTION 'falta el rol mtw_readonly (ver infra/local/postgres/init-db.sh)';
     END IF;
   END $$`,

  // citext es una extensión "trusted": la crea el dueño de la base (mtw_migrator) sin superusuario.
  `CREATE EXTENSION IF NOT EXISTS citext`,

  `CREATE DOMAIN eth_address AS bytea CHECK (octet_length(VALUE) = 20)`,
  `CREATE DOMAIN bytes32 AS bytea CHECK (octet_length(VALUE) = 32)`,
  `CREATE DOMAIN uint256 AS numeric(78, 0)
     CHECK (VALUE >= 0 AND VALUE < 115792089237316195423570985008687907853269984665640564039457584007913129639936)`,
  `CREATE DOMAIN ecdsa_signature AS bytea CHECK (octet_length(VALUE) = 65)`,

  `CREATE FUNCTION mtw_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.updated_at := now();
     RETURN NEW;
   END $$`,

  `CREATE FUNCTION mtw_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '% es append-only: % rechazado', TG_TABLE_NAME, TG_OP
       USING ERRCODE = 'insufficient_privilege';
   END $$`,

  // --- Cuenta -----------------------------------------------------------------------------------------------
  `CREATE TABLE users (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     platform_id text NOT NULL CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
     email citext NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND position('@' in email) > 1),
     email_verified_at timestamptz,
     password_hash text NOT NULL,
     pepper_version smallint NOT NULL CHECK (pepper_version >= 1),
     status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
     failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
     locked_until timestamptz,
     totp_enabled boolean NOT NULL DEFAULT false,
     global_user_id uuid,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT users_platform_email_key UNIQUE (platform_id, email)
   )`,

  `CREATE TABLE sessions (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     client text NOT NULL CHECK (client IN ('WALLET', 'RECOVERY')),
     token_hash bytes32 NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_seen_at timestamptz NOT NULL DEFAULT now(),
     idle_expires_at timestamptz NOT NULL,
     absolute_expires_at timestamptz NOT NULL,
     rotated_from_id uuid REFERENCES sessions (id) ON DELETE RESTRICT,
     revoked_at timestamptz,
     revoke_reason text,
     ip_prefix text,
     user_agent text CHECK (length(user_agent) <= 512),
     CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
     CONSTRAINT sessions_idle_within_absolute CHECK (idle_expires_at <= absolute_expires_at),
     CONSTRAINT sessions_revocation_reason CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
   )`,
  `CREATE INDEX sessions_user_revoked_idx ON sessions (user_id, revoked_at)`,

  // --- Wallet -----------------------------------------------------------------------------------------------
  `CREATE TABLE wallets (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     platform_id text NOT NULL CHECK (platform_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     status text NOT NULL CHECK (status IN ('CREATING', 'DEPLOYING', 'VERIFYING', 'ACTIVE', 'SOVEREIGN_MODIFIED',
                                            'MIGRATING', 'FAILED', 'MIGRATED', 'ABANDONED')),
     migrated_from_wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     safe_address eth_address,
     salt_nonce uint256,
     factory_address eth_address,
     singleton_address eth_address,
     config_hash bytes32,
     next_safe_nonce uint256 NOT NULL DEFAULT 0,
     exec_lease_owner text,
     exec_lease_expires_at timestamptz,
     exec_lease_version bigint NOT NULL DEFAULT 0 CHECK (exec_lease_version >= 0),
     deploy_tx_hash bytes32,
     deploy_block_number bigint CHECK (deploy_block_number >= 0),
     created_at timestamptz NOT NULL DEFAULT now(),
     activated_at timestamptz,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT wallets_chain_safe_key UNIQUE (chain_id, safe_address),
     CONSTRAINT wallets_not_migrated_from_itself CHECK (migrated_from_wallet_id <> id),
     CONSTRAINT wallets_active_has_safe CHECK (status NOT IN ('ACTIVE', 'SOVEREIGN_MODIFIED') OR safe_address IS NOT NULL)
   )`,
  // V1: una wallet viva por usuario; durante una migración la vieja queda MIGRATING y la nueva puede crearse.
  `CREATE UNIQUE INDEX wallets_one_live_per_user_key ON wallets (user_id)
     WHERE status NOT IN ('FAILED', 'ABANDONED', 'MIGRATED', 'MIGRATING')`,

  `CREATE TABLE platform_sessions (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     account_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE RESTRICT,
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     scope text NOT NULL CHECK (scope IN ('OPERATIONS', 'ONBOARDING', 'RECOVERY', 'U_REPLACEMENT', 'ENROLLMENT',
                                          'KEY_RESTORE')),
     auth_method text NOT NULL CHECK (auth_method IN ('OPAQUE_U', 'STEP_UP')),
     session_public_key_jwk jsonb NOT NULL,
     issued_at timestamptz NOT NULL,
     expires_at timestamptz NOT NULL,
     revoked_at timestamptz,
     CONSTRAINT platform_sessions_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
     -- [B-PSES-01/03]: OPERATIONS sólo por OPAQUE; el step-up nunca la otorga.
     CONSTRAINT platform_sessions_operations_need_opaque CHECK (scope <> 'OPERATIONS' OR auth_method = 'OPAQUE_U')
   )`,
  `CREATE INDEX platform_sessions_user_expires_idx ON platform_sessions (user_id, expires_at)`,
  `CREATE INDEX platform_sessions_account_session_idx ON platform_sessions (account_session_id)`,

  `CREATE TABLE opaque_records (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     key_version integer NOT NULL CHECK (key_version >= 1),
     registration_record bytea NOT NULL,
     key_stretching jsonb NOT NULL,
     status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'RETIRED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     activated_at timestamptz,
     CONSTRAINT opaque_records_activation CHECK (status = 'PENDING' OR activated_at IS NOT NULL OR status = 'RETIRED')
   )`,
  `CREATE UNIQUE INDEX opaque_records_wallet_active_key ON opaque_records (wallet_id) WHERE status = 'ACTIVE'`,

  `CREATE TABLE totp_factors (
     user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
     secret_ciphertext bytea NOT NULL,
     last_used_step bigint CHECK (last_used_step >= 0),
     recovery_code_hashes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recovery_code_hashes) <= 10),
     enabled_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE wallet_keys_metadata (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     role text NOT NULL CHECK (role IN ('U', 'R', 'S')),
     key_address eth_address NOT NULL,
     key_version integer NOT NULL CHECK (key_version >= 1),
     status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ROTATED_OUT', 'REVOKED')),
     source text NOT NULL CHECK (source IN ('INTERNAL', 'EXTERNAL_WALLET', 'SIGNER_SHARD')),
     kdf_params jsonb,
     storage_flags jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now(),
     activated_at timestamptz,
     deactivated_at timestamptz,
     CONSTRAINT wallet_keys_s_from_signer CHECK ((role = 'S') = (source = 'SIGNER_SHARD'))
   )`,
  `CREATE UNIQUE INDEX wallet_keys_active_role_key ON wallet_keys_metadata (wallet_id, role) WHERE status = 'ACTIVE'`,
  // Una misma clave nunca puede estar viva en dos lugares (ni en dos roles ni en dos wallets).
  `CREATE UNIQUE INDEX wallet_keys_live_address_key ON wallet_keys_metadata (key_address)
     WHERE status IN ('PENDING', 'ACTIVE')`,

  `CREATE TABLE recovery_metadata (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     enrollment_id uuid NOT NULL,
     r_address eth_address,
     r_type text CHECK (r_type IN ('INTERNAL', 'EXTERNAL')),
     connector_id text,
     enrollment_key_jwk jsonb,
     enrollment_payload jsonb,
     enrollment_key_signature bytea,
     r_proof_signature bytea,
     u_incorporation_signature bytea,
     status text NOT NULL CHECK (status IN ('REQUESTED', 'SUBMITTED', 'CONFIRMED', 'EXPIRED', 'REJECTED')),
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT recovery_metadata_enrollment_key UNIQUE (enrollment_id),
     CONSTRAINT recovery_metadata_confirmed_has_r CHECK (status <> 'CONFIRMED' OR r_address IS NOT NULL)
   )`,

  `CREATE TABLE signer_keys (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     shard_id text NOT NULL CHECK (shard_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
     key_ref text NOT NULL,
     address eth_address NOT NULL,
     provider text NOT NULL CHECK (provider IN ('development', 'selfhosted', 'hardware')),
     status text NOT NULL CHECK (status IN ('ACTIVE', 'PENDING', 'RETIRED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT signer_keys_address_key UNIQUE (address)
   )`,
  `CREATE UNIQUE INDEX signer_keys_wallet_active_key ON signer_keys (wallet_id) WHERE status = 'ACTIVE'`,

  `CREATE TABLE security_challenges (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     type text NOT NULL CHECK (type IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LOGIN_UNLOCK', 'STEP_UP', 'WHITELIST_ADD',
                                        'ROTATION', 'HIGH_VALUE_TX', 'MIGRATION')),
     binding jsonb NOT NULL DEFAULT '{}',
     code_hash bytea NOT NULL,
     attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     max_attempts integer NOT NULL CHECK (max_attempts > 0),
     expires_at timestamptz NOT NULL,
     consumed_at timestamptz,
     created_ip_prefix text,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT security_challenges_attempts CHECK (attempts <= max_attempts)
   )`,
  `CREATE INDEX security_challenges_user_type_created_idx ON security_challenges (user_id, type, created_at)`,

  // --- Operaciones ------------------------------------------------------------------------------------------
  `CREATE TABLE operation_groups (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     type text NOT NULL CHECK (type IN ('SWAP')),
     status text NOT NULL CHECK (status IN ('OPEN', 'COMPLETED', 'FAILED', 'CANCELLED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE wallet_operations (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     safe_address eth_address NOT NULL,
     chain_id integer NOT NULL CHECK (chain_id > 0),
     safe_nonce uint256 NOT NULL,
     operation_type text NOT NULL CHECK (operation_type IN ('SEND', 'SWAP_APPROVE', 'SWAP', 'WHITELIST_ADD',
                                         'WHITELIST_REMOVE', 'ROTATION_PROPOSE', 'ROTATION_EXECUTE', 'NOOP_CANCEL',
                                         'MIGRATION_TRANSFER', 'APPROVE_REVOKE', 'GUARD_UPGRADE')),
     group_id uuid REFERENCES operation_groups (id) ON DELETE RESTRICT,
     safe_tx_hash bytes32 NOT NULL,
     target eth_address NOT NULL,
     value uint256 NOT NULL DEFAULT 0,
     calldata bytea NOT NULL,
     canonical_intent jsonb NOT NULL,
     owner_signature ecdsa_signature,
     owner_role text CHECK (owner_role IN ('U', 'R')),
     s_signature ecdsa_signature,
     platform_session_id uuid REFERENCES platform_sessions (id) ON DELETE RESTRICT,
     submission_envelope jsonb,
     policy_snapshot_version integer CHECK (policy_snapshot_version >= 1),
     two_factor_challenge_id uuid REFERENCES security_challenges (id) ON DELETE RESTRICT,
     status text NOT NULL CHECK (status IN ('CREATED', 'USER_SIGNED', 'QUEUED', 'VALIDATING', 'READY', 'SUBMITTED',
                                            'MINED', 'CONFIRMED', 'FINALIZED', 'FAILED_RETRYABLE', 'FAILED_FINAL',
                                            'REORGED', 'CANCEL_REQUESTED', 'CANCELLED', 'EXPIRED')),
     failure_reason text,
     last_error_code text,
     retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
     next_attempt_at timestamptz,
     lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     submitted_at timestamptz,
     mined_at timestamptz,
     executed_at timestamptz,
     confirmed_at timestamptz,
     finalized_at timestamptz,
     tx_hash bytes32,
     block_number bigint CHECK (block_number >= 0),
     block_hash bytes32,
     CONSTRAINT wallet_operations_safe_tx_hash_key UNIQUE (safe_tx_hash),
     CONSTRAINT wallet_operations_signature_role CHECK ((owner_signature IS NULL) = (owner_role IS NULL)),
     CONSTRAINT wallet_operations_signed_states CHECK (status IN ('CREATED', 'EXPIRED', 'CANCELLED') OR owner_signature IS NOT NULL)
   )`,
  // [B-NONCE-01]: una sola operación activa por (Safe, nonce).
  `CREATE UNIQUE INDEX wallet_operations_active_nonce_key ON wallet_operations (chain_id, safe_address, safe_nonce)
     WHERE status IN ('USER_SIGNED', 'QUEUED', 'VALIDATING', 'READY', 'SUBMITTED', 'MINED', 'FAILED_RETRYABLE',
                      'REORGED', 'CONFIRMED', 'FINALIZED')`,
  `CREATE INDEX wallet_operations_wallet_created_idx ON wallet_operations (wallet_id, created_at DESC)`,
  `CREATE INDEX wallet_operations_pending_idx ON wallet_operations (status, next_attempt_at)
     WHERE status NOT IN ('FINALIZED', 'FAILED_FINAL', 'CANCELLED', 'EXPIRED')`,

  `CREATE TABLE whitelist_requests (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     destination eth_address NOT NULL,
     label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
     status text NOT NULL CHECK (status IN ('PENDING_CHALLENGE', 'CHALLENGE_PASSED', 'AWAITING_SIGNATURE', 'SUBMITTED',
                                            'ACTIVATING', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'FAILED')),
     challenge_id uuid REFERENCES security_challenges (id) ON DELETE RESTRICT,
     operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX whitelist_requests_open_key ON whitelist_requests (wallet_id, destination)
     WHERE status NOT IN ('EXPIRED', 'CANCELLED', 'FAILED', 'ACTIVE')`,

  `CREATE TABLE whitelisted_destinations (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     destination eth_address NOT NULL,
     label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
     status text NOT NULL CHECK (status IN ('ACTIVATING', 'ACTIVE', 'REMOVED')),
     activates_at timestamptz NOT NULL,
     added_tx_hash bytes32,
     removed_tx_hash bytes32,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT whitelisted_destinations_removed_tx CHECK (status <> 'REMOVED' OR removed_tx_hash IS NOT NULL)
   )`,
  `CREATE UNIQUE INDEX whitelisted_destinations_live_key ON whitelisted_destinations (wallet_id, destination)
     WHERE status IN ('ACTIVATING', 'ACTIVE')`,

  `CREATE TABLE chain_transactions (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT,
     purpose text NOT NULL CHECK (purpose IN ('EXEC', 'DEPLOY', 'TOPUP', 'CANCEL_RELAY')),
     from_address eth_address NOT NULL,
     account_nonce bigint NOT NULL CHECK (account_nonce >= 0),
     tx_hash bytes32 NOT NULL,
     raw_tx bytea NOT NULL,
     max_fee_per_gas uint256 NOT NULL,
     max_priority_fee_per_gas uint256 NOT NULL,
     gas_limit uint256 NOT NULL,
     status text NOT NULL CHECK (status IN ('BROADCAST', 'MINED', 'CONFIRMED', 'FINALIZED', 'REPLACED', 'DROPPED',
                                            'REORGED', 'FAILED')),
     replaced_by_id uuid REFERENCES chain_transactions (id) ON DELETE RESTRICT,
     block_number bigint CHECK (block_number >= 0),
     block_hash bytes32,
     receipt_status smallint CHECK (receipt_status IN (0, 1)),
     gas_used uint256,
     effective_gas_price uint256,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT chain_transactions_tx_hash_key UNIQUE (tx_hash),
     CONSTRAINT chain_transactions_account_nonce_key UNIQUE (chain_id, from_address, account_nonce, tx_hash),
     CONSTRAINT chain_transactions_priority_fee CHECK (max_priority_fee_per_gas <= max_fee_per_gas)
   )`,
  `CREATE INDEX chain_transactions_operation_idx ON chain_transactions (operation_id)`,

  `CREATE TABLE rotation_requests (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
     role text NOT NULL CHECK (role IN ('U', 'R', 'S')),
     old_key eth_address NOT NULL,
     new_key eth_address NOT NULL,
     proposal_id bytes32,
     initiated_by text NOT NULL CHECK (initiated_by IN ('U', 'R')),
     status text NOT NULL CHECK (status IN ('DRAFT', 'AWAITING_SIGNATURE', 'PROPOSING', 'PENDING_TIMELOCK',
                                            'READY_TO_EXECUTE', 'EXECUTING', 'EXECUTED', 'CANCELLED', 'FAILED')),
     propose_operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT,
     execute_operation_id uuid REFERENCES wallet_operations (id) ON DELETE RESTRICT,
     executable_at timestamptz,
     cancelled_by text CHECK (cancelled_by IN ('U', 'R', 'SAFE')),
     cancel_tx_hash bytes32,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT rotation_requests_distinct_keys CHECK (old_key <> new_key),
     CONSTRAINT rotation_requests_cancelled_by CHECK ((status = 'CANCELLED') = (cancelled_by IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX rotation_requests_live_role_key ON rotation_requests (wallet_id, role)
     WHERE status IN ('PROPOSING', 'PENDING_TIMELOCK', 'READY_TO_EXECUTE', 'EXECUTING')`,

  // Un mismo log de Transfer entre dos Safes de la plataforma genera una fila por Safe (OUT e IN): la unicidad
  // incluye la Safe (cambio respecto de [B-DB], que la fijaba sólo por chain_id + tx_hash + log_index).
  `CREATE TABLE token_transfers (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     chain_id integer NOT NULL CHECK (chain_id > 0),
     safe_address eth_address NOT NULL,
     token eth_address NOT NULL,
     direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
     counterparty eth_address NOT NULL,
     amount uint256 NOT NULL,
     tx_hash bytes32 NOT NULL,
     log_index integer NOT NULL CHECK (log_index >= 0),
     block_number bigint NOT NULL CHECK (block_number >= 0),
     block_hash bytes32 NOT NULL,
     status text NOT NULL CHECK (status IN ('MINED', 'CONFIRMED', 'FINALIZED', 'REORGED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT token_transfers_log_safe_key UNIQUE (chain_id, tx_hash, log_index, safe_address),
     CONSTRAINT token_transfers_wallet_fk FOREIGN KEY (chain_id, safe_address)
       REFERENCES wallets (chain_id, safe_address) ON DELETE RESTRICT
   )`,
  `CREATE INDEX token_transfers_safe_block_idx ON token_transfers (chain_id, safe_address, block_number DESC)`,

  // --- Auditoría, outbox, idempotencia y notificaciones -----------------------------------------------------
  // audit_events: sin FKs a propósito (la cadena nunca depende de otras tablas: registra intentos sobre usuarios
  // inexistentes y su verificación sólo lee esta tabla). Los ids los asigna el audit writer bajo el advisory lock.
  `CREATE TABLE audit_events (
     id bigserial PRIMARY KEY,
     occurred_at timestamptz NOT NULL,
     actor_type text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'WORKER', 'SIGNER', 'OPERATOR')),
     actor_id text,
     user_id uuid,
     wallet_id uuid,
     session_id uuid,
     event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
     target_type text,
     target_id text,
     request_id text,
     ip_prefix text,
     payload jsonb NOT NULL DEFAULT '{}',
     prev_hash bytes32 NOT NULL,
     entry_hash bytes32 NOT NULL,
     CONSTRAINT audit_events_entry_hash_key UNIQUE (entry_hash),
     CONSTRAINT audit_events_prev_hash_key UNIQUE (prev_hash)
   )`,
  `CREATE INDEX audit_events_user_idx ON audit_events (user_id, occurred_at)`,
  `CREATE INDEX audit_events_type_idx ON audit_events (event_type, occurred_at)`,
  `CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
     FOR EACH ROW EXECUTE FUNCTION mtw_reject_mutation()`,
  `CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
     FOR EACH STATEMENT EXECUTE FUNCTION mtw_reject_mutation()`,
  // Punto de serialización de los escritores de auditoría en REPEATABLE READ/SERIALIZABLE: `LOCK TABLE` como
  // primera sentencia no toma snapshot, así la transacción ve la cabeza de la cadena vigente (sin datos; mtw_app
  // necesita UPDATE para el modo EXCLUSIVE, que no tiene sobre audit_events).
  `CREATE TABLE audit_chain_lock (
     id boolean PRIMARY KEY DEFAULT true CHECK (id)
   )`,

  // processed_at: confirmación del consumidor; permite re-encolar desde Postgres lo publicado y no procesado si
  // Valkey pierde su estado [B-Q-01] (columna agregada respecto de [B-DB]).
  `CREATE TABLE outbox_events (
     id bigserial PRIMARY KEY,
     aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{1,62}$'),
     aggregate_id uuid NOT NULL,
     event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
     payload jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now(),
     dispatched_at timestamptz,
     attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
     last_error text,
     processed_at timestamptz,
     CONSTRAINT outbox_events_processed_after_dispatch CHECK (processed_at IS NULL OR dispatched_at IS NOT NULL)
   )`,
  `CREATE INDEX outbox_events_dispatch_idx ON outbox_events (dispatched_at NULLS FIRST, id)`,
  `CREATE INDEX outbox_events_unprocessed_idx ON outbox_events (id) WHERE processed_at IS NULL`,

  `CREATE TABLE idempotency_keys (
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
     request_hash bytes32 NOT NULL,
     status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
     response_status smallint CHECK (response_status BETWEEN 100 AND 599),
     response_body jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     PRIMARY KEY (user_id, key),
     CONSTRAINT idempotency_keys_completed_has_response CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL),
     CONSTRAINT idempotency_keys_expiry CHECK (expires_at > created_at)
   )`,
  `CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at)`,

  `CREATE TABLE notifications (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
     wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     type text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
     payload jsonb NOT NULL DEFAULT '{}',
     read_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX notifications_user_read_idx ON notifications (user_id, read_at)`,

  // --- Operadores, policy, integridad y gas tank ------------------------------------------------------------
  `CREATE TABLE operator_users (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     email citext NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND position('@' in email) > 1),
     display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
     totp_secret_ciphertext bytea NOT NULL,
     status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT operator_users_email_key UNIQUE (email)
   )`,

  `CREATE TABLE operator_actions (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     action_type text NOT NULL CHECK (action_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
     wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT,
     payload jsonb NOT NULL DEFAULT '{}',
     approver_1 uuid NOT NULL REFERENCES operator_users (id) ON DELETE RESTRICT,
     approver_2 uuid NOT NULL REFERENCES operator_users (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT operator_actions_two_approvers CHECK (approver_1 <> approver_2)
   )`,
  `CREATE TRIGGER operator_actions_append_only BEFORE UPDATE OR DELETE ON operator_actions
     FOR EACH ROW EXECUTE FUNCTION mtw_reject_mutation()`,
  `CREATE TRIGGER operator_actions_no_truncate BEFORE TRUNCATE ON operator_actions
     FOR EACH STATEMENT EXECUTE FUNCTION mtw_reject_mutation()`,

  `CREATE TABLE policy_snapshots (
     version integer PRIMARY KEY CHECK (version >= 1),
     sha256 bytes32 NOT NULL,
     signature bytea NOT NULL CHECK (octet_length(signature) = 64),
     payload jsonb NOT NULL,
     activated_at timestamptz
   )`,

  `CREATE TABLE integrity_status (
     id bigserial PRIMARY KEY,
     app text NOT NULL CHECK (app IN ('WALLET', 'RECOVERY')),
     release_id text NOT NULL,
     status text NOT NULL CHECK (status IN ('OK', 'MISMATCH', 'UNREACHABLE')),
     details jsonb NOT NULL DEFAULT '{}',
     observed_at timestamptz NOT NULL
   )`,
  `CREATE INDEX integrity_status_app_observed_idx ON integrity_status (app, observed_at)`,

  `CREATE TABLE gas_topups (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     executor_address eth_address NOT NULL,
     amount_wei uint256 NOT NULL CHECK (amount_wei > 0),
     tx_id uuid NOT NULL REFERENCES chain_transactions (id) ON DELETE RESTRICT,
     reason text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX gas_topups_created_idx ON gas_topups (created_at)`,
];

const UPDATED_AT_TABLES = [
  'users',
  'wallets',
  'operation_groups',
  'wallet_operations',
  'whitelist_requests',
  'whitelisted_destinations',
  'chain_transactions',
  'rotation_requests',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  for (const table of UPDATED_AT_TABLES) {
    await sql
      .raw(
        `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION mtw_set_updated_at()`,
      )
      .execute(db);
  }
  await grantStandardAccess(db, {
    appendOnly: ['audit_events', 'operator_actions'],
    // mtw_readonly (soporte, análisis) nunca lee hashes de password ni secretos cifrados.
    readonlyExcludedColumns: {
      users: ['password_hash'],
      totp_factors: ['secret_ciphertext', 'recovery_code_hashes'],
      opaque_records: ['registration_record'],
      operator_users: ['totp_secret_ciphertext'],
      sessions: ['token_hash'],
    },
  });
}
