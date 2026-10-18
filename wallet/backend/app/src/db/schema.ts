// Tipos de Kysely para el modelo de datos [B-DB] (migración 0001). pg devuelve: uuid/text/citext → string,
// timestamptz → Date, bytea → Buffer, numeric e int8 → string, jsonb → valor parseado.
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// Generated<T> de Kysely no admite un ColumnType adentro: las columnas con default tienen su propio ColumnType
// (insert opcional).
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;
type GeneratedInt8 = ColumnType<string, string | number | bigint | undefined, string | number | bigint>;
type Numeric = ColumnType<string, string | number | bigint, string | number | bigint>;
type GeneratedNumeric = ColumnType<string, string | number | bigint | undefined, string | number | bigint>;
type Json<T = unknown> = ColumnType<T, string, string>;
type GeneratedJson<T = unknown> = ColumnType<T, string | undefined, string>;
type Bytes = Buffer;

export type AccountStatus = 'ACTIVE' | 'LOCKED' | 'DISABLED';
export type Client = 'WALLET' | 'RECOVERY';
export type PlatformSessionScope =
  'OPERATIONS' | 'ONBOARDING' | 'RECOVERY' | 'U_REPLACEMENT' | 'ENROLLMENT' | 'KEY_RESTORE';
export type WalletStatus =
  | 'CREATING'
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'ACTIVE'
  | 'SOVEREIGN_MODIFIED'
  | 'MIGRATING'
  | 'FAILED'
  | 'MIGRATED'
  | 'ABANDONED';
export type KeyRole = 'U' | 'R' | 'S';
export type OperationType =
  | 'SEND'
  | 'SWAP_APPROVE'
  | 'SWAP'
  | 'WHITELIST_ADD'
  | 'WHITELIST_REMOVE'
  | 'ROTATION_PROPOSE'
  | 'ROTATION_EXECUTE'
  | 'NOOP_CANCEL'
  | 'MIGRATION_TRANSFER'
  | 'APPROVE_REVOKE'
  | 'GUARD_UPGRADE';
export type OperationStatus =
  | 'CREATED'
  | 'USER_SIGNED'
  | 'QUEUED'
  | 'VALIDATING'
  | 'READY'
  | 'SUBMITTED'
  | 'MINED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'REORGED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'EXPIRED';
export type AuditActorType = 'USER' | 'SYSTEM' | 'WORKER' | 'SIGNER' | 'OPERATOR';

export interface UsersTable {
  id: Generated<string>;
  platform_id: string;
  email: string;
  email_verified_at: Timestamp | null;
  password_hash: string;
  pepper_version: number;
  status: Generated<AccountStatus>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  totp_enabled: Generated<boolean>;
  global_user_id: string | null;
  locale: Generated<string>;
  time_zone: Generated<string>;
  last_failed_login_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  client: Client;
  token_hash: Bytes;
  created_at: GeneratedTimestamp;
  last_seen_at: GeneratedTimestamp;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  rotated_from_id: string | null;
  revoked_at: Timestamp | null;
  revoke_reason: string | null;
  ip_prefix: string | null;
  user_agent: string | null;
}

export interface PlatformSessionsTable {
  id: Generated<string>;
  account_session_id: string;
  user_id: string;
  wallet_id: string | null;
  scope: PlatformSessionScope;
  auth_method: 'OPAQUE_U' | 'STEP_UP';
  session_public_key_jwk: Json;
  issued_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface OpaqueRecordsTable {
  id: Generated<string>;
  user_id: string;
  wallet_id: string;
  key_version: number;
  registration_record: Bytes;
  key_stretching: Json;
  status: 'PENDING' | 'ACTIVE' | 'RETIRED';
  created_at: GeneratedTimestamp;
  activated_at: Timestamp | null;
}

export interface TotpFactorsTable {
  user_id: string;
  secret_ciphertext: Bytes;
  last_used_step: Int8 | null;
  recovery_code_hashes: Generated<string[]>;
  enabled_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface WalletsTable {
  id: Generated<string>;
  user_id: string;
  platform_id: string;
  chain_id: number;
  status: WalletStatus;
  migrated_from_wallet_id: string | null;
  safe_address: Bytes | null;
  salt_nonce: Numeric | null;
  factory_address: Bytes | null;
  singleton_address: Bytes | null;
  config_hash: Bytes | null;
  next_safe_nonce: GeneratedNumeric;
  exec_lease_owner: string | null;
  exec_lease_expires_at: Timestamp | null;
  exec_lease_version: GeneratedInt8;
  deploy_tx_hash: Bytes | null;
  deploy_block_number: Int8 | null;
  created_at: GeneratedTimestamp;
  activated_at: Timestamp | null;
  updated_at: GeneratedTimestamp;
  /** Safe esperada (CREATE2) hasta que el deploy se mina; `safe_address` sólo existe con la Safe desplegada. */
  expected_safe: Bytes | null;
  /** Motivo de un FAILED (p. ej. el ítem de la verificación post-deploy que no coincidió). */
  failure_reason: string | null;
  deploy_requested_at: Timestamp | null;
  /** P13.T11: ítems de configuración de la Safe que difieren (SOVEREIGN_MODIFIED). */
  config_drift: Json<string[]> | null;
  config_drift_at: Timestamp | null;
}

export interface WalletKeysMetadataTable {
  id: Generated<string>;
  wallet_id: string;
  role: KeyRole;
  key_address: Bytes;
  key_version: number;
  status: 'PENDING' | 'ACTIVE' | 'ROTATED_OUT' | 'REVOKED';
  source: 'INTERNAL' | 'EXTERNAL_WALLET' | 'SIGNER_SHARD';
  kdf_params: Json | null;
  storage_flags: GeneratedJson;
  created_at: GeneratedTimestamp;
  activated_at: Timestamp | null;
  deactivated_at: Timestamp | null;
  /** P15: credencial sana reutilizada por la Safe nueva de una migración excepcional (viva en las dos wallets). */
  reused_from_wallet_id: string | null;
}

export interface RecoveryMetadataTable {
  id: Generated<string>;
  wallet_id: string;
  enrollment_id: string;
  r_address: Bytes | null;
  r_type: 'INTERNAL' | 'EXTERNAL' | null;
  connector_id: string | null;
  enrollment_key_jwk: Json | null;
  enrollment_payload: Json | null;
  enrollment_key_signature: Bytes | null;
  r_proof_signature: Bytes | null;
  u_incorporation_signature: Bytes | null;
  status: 'REQUESTED' | 'SUBMITTED' | 'CONFIRMED' | 'EXPIRED' | 'REJECTED' | 'RETIRED';
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
  /** Nonce del enrollment (32 bytes): RecoveryEnrollment.nonce y WalletCreationAuthorization.enrollmentNonce. */
  nonce: Bytes | null;
  /** Backups de una R interna (los mismos flags que U). */
  storage_flags: Json | null;
  submitted_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  /** P15: ONBOARDING (R de la Safe nueva) o REPLACEMENT (R' de una wallet ACTIVE). */
  purpose: Generated<'ONBOARDING' | 'REPLACEMENT'>;
  /** P15: KeyAcceptance de R' ({nonce, signature}) para la rotación. */
  key_acceptance: Json<KeyAcceptanceJson> | null;
  retired_at: Timestamp | null;
  /** P15: R sana reutilizada por la Safe nueva de una migración excepcional (viva también en la vieja). */
  reused_from_wallet_id: string | null;
}

/** KeyAcceptance [W-01] firmada por la clave nueva (U' o R'). */
export interface KeyAcceptanceJson {
  nonce: string;
  signature: string;
}

export interface SignerKeysTable {
  id: Generated<string>;
  wallet_id: string;
  shard_id: string;
  key_ref: string;
  address: Bytes;
  provider: 'development' | 'selfhosted' | 'hardware';
  status: 'ACTIVE' | 'PENDING' | 'RETIRED';
  /** SignerKeyAttestation (JWS) que emitió el shard al crear la clave [B-SIG-07]. */
  attestation: string | null;
  created_at: GeneratedTimestamp;
  /** P15: la S dejó de ser la de la Safe (rotación o reemplazo soberano). */
  retired_at: Timestamp | null;
  /** P15: el shard confirmó el retiro ([B-SIG-08]: deja de firmar y destruye el keystore a los 30 días). */
  signer_retired_at: Timestamp | null;
}

export interface SecurityChallengesTable {
  id: Generated<string>;
  user_id: string;
  wallet_id: string | null;
  type:
    | 'EMAIL_VERIFY'
    | 'PASSWORD_RESET'
    | 'LOGIN_UNLOCK'
    | 'STEP_UP'
    | 'WHITELIST_ADD'
    | 'ROTATION'
    | 'HIGH_VALUE_TX'
    | 'MIGRATION';
  binding: GeneratedJson;
  code_hash: Bytes;
  attempts: Generated<number>;
  max_attempts: number;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_ip_prefix: string | null;
  created_at: GeneratedTimestamp;
}

export interface WhitelistRequestsTable {
  id: Generated<string>;
  wallet_id: string;
  user_id: string;
  destination: Bytes;
  label: string;
  status:
    | 'PENDING_CHALLENGE'
    | 'CHALLENGE_PASSED'
    | 'AWAITING_SIGNATURE'
    | 'SUBMITTED'
    | 'ACTIVATING'
    | 'ACTIVE'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'FAILED';
  challenge_id: string | null;
  operation_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  /** P14: motivo de EXPIRED/CANCELLED/FAILED. */
  failure_reason: string | null;
  /** P14: momento en que se superó el challenge (ventana para reintentar el prepare tras un error transitorio). */
  challenge_passed_at: Timestamp | null;
}

export interface WhitelistedDestinationsTable {
  id: Generated<string>;
  wallet_id: string;
  destination: Bytes;
  label: string;
  status: 'ACTIVATING' | 'ACTIVE' | 'REMOVED';
  activates_at: Timestamp;
  added_tx_hash: Bytes | null;
  removed_tx_hash: Bytes | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  /** P14: PLATFORM (SafeTx U+S de la plataforma) o SOVEREIGN (alta U+R por fuera). */
  origin: Generated<'PLATFORM' | 'SOVEREIGN'>;
  request_id: string | null;
  activated_at: Timestamp | null;
  removed_at: Timestamp | null;
  removed_by: 'U' | 'R' | 'SAFE' | null;
}

/** P14: eventos de DestinationWhitelist de las Safes de la plataforma (indexados con finalidad y reorgs). */
export interface WhitelistEventsTable {
  id: Generated<string>;
  chain_id: number;
  safe_address: Bytes;
  destination: Bytes;
  kind: 'ADDED' | 'REMOVED';
  activates_at: Timestamp | null;
  tx_hash: Bytes;
  log_index: number;
  block_number: Int8;
  block_hash: Bytes;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'REORGED';
  applied_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Cotización vigente de un grupo de swap (P14.T04). */
export interface SwapQuoteJson {
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  priceImpactBps: number;
  deadline: string;
  blockNumber: string;
  quotedAt: string;
}

export interface OperationGroupsTable {
  id: Generated<string>;
  wallet_id: string;
  type: 'SWAP';
  status: 'OPEN' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  user_id: string;
  token_in: Bytes;
  token_out: Bytes;
  amount_in: Numeric;
  quote: Json<SwapQuoteJson>;
  failure_reason: string | null;
  completed_at: Timestamp | null;
  allowance_notified_at: Timestamp | null;
}

export interface WalletOperationsTable {
  id: Generated<string>;
  user_id: string;
  wallet_id: string;
  safe_address: Bytes;
  chain_id: number;
  safe_nonce: Numeric;
  operation_type: OperationType;
  group_id: string | null;
  safe_tx_hash: Bytes;
  target: Bytes;
  value: GeneratedNumeric;
  calldata: Bytes;
  canonical_intent: Json;
  owner_signature: Bytes | null;
  owner_role: 'U' | 'R' | null;
  s_signature: Bytes | null;
  platform_session_id: string | null;
  submission_envelope: Json | null;
  policy_snapshot_version: number | null;
  two_factor_challenge_id: string | null;
  status: OperationStatus;
  failure_reason: string | null;
  last_error_code: string | null;
  retry_count: Generated<number>;
  next_attempt_at: Timestamp | null;
  lease_version: GeneratedInt8;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  submitted_at: Timestamp | null;
  mined_at: Timestamp | null;
  executed_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  finalized_at: Timestamp | null;
  tx_hash: Bytes | null;
  block_number: Int8 | null;
  block_hash: Bytes | null;
  /** P13: vencimiento de una CREATED (15 min sin firma). */
  expires_at: Timestamp | null;
  /** [B-NONCE-03]: QUEUED a la espera de que se ejecute el nonce menor. */
  blocked_reason: 'WAITING_LOWER_NONCE' | null;
  /** Firma P-256 (base64url) del envelope de envío [B-PSES-06]. */
  submission_envelope_signature: string | null;
  /** PlatformSession (JWS) con la que se envió la firma; el signer la vuelve a verificar. */
  platform_session_token: string | null;
  /** ChallengeCompletion (JWS) del 2FA o del challenge de whitelist, si la operación lo exige. */
  challenge_attestation: string | null;
  requires_two_factor: Generated<boolean>;
  /** Momento (servidor) en que se aceptó la firma U/R. */
  signed_at: Timestamp | null;
  /** NOOP_CANCEL: la operación que cancela [B-NONCE-06]. */
  cancels_operation_id: string | null;
}

export interface ChainTransactionsTable {
  id: Generated<string>;
  chain_id: number;
  operation_id: string | null;
  purpose: 'EXEC' | 'DEPLOY' | 'TOPUP' | 'CANCEL_RELAY';
  from_address: Bytes;
  account_nonce: Int8;
  tx_hash: Bytes;
  raw_tx: Bytes;
  max_fee_per_gas: Numeric;
  max_priority_fee_per_gas: Numeric;
  gas_limit: Numeric;
  status: 'BROADCAST' | 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'REPLACED' | 'DROPPED' | 'REORGED' | 'FAILED';
  replaced_by_id: string | null;
  block_number: Int8 | null;
  block_hash: Bytes | null;
  receipt_status: number | null;
  gas_used: Numeric | null;
  effective_gas_price: Numeric | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RotationRole = KeyRole | 'GUARD' | 'MODULE_GUARD';

export interface RotationRequestsTable {
  id: Generated<string>;
  wallet_id: string;
  role: RotationRole;
  old_key: Bytes;
  new_key: Bytes;
  proposal_id: Bytes | null;
  initiated_by: 'U' | 'R' | 'SAFE';
  status:
    | 'DRAFT'
    | 'AWAITING_SIGNATURE'
    | 'PROPOSING'
    | 'PENDING_TIMELOCK'
    | 'READY_TO_EXECUTE'
    | 'EXECUTING'
    | 'EXECUTED'
    | 'CANCELLED'
    | 'FAILED';
  propose_operation_id: string | null;
  execute_operation_id: string | null;
  executable_at: Timestamp | null;
  cancelled_by: 'U' | 'R' | 'SAFE' | null;
  cancel_tx_hash: Bytes | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  /** P15: PLATFORM (la preparó el backend) u ONCHAIN (propuesta detectada en la cadena que no originó el backend). */
  origin: Generated<'PLATFORM' | 'ONCHAIN'>;
  key_acceptance: Json<KeyAcceptanceJson> | null;
  new_key_attestation: string | null;
  opaque_record_id: string | null;
  enrollment_id: string | null;
  proposed_at: Timestamp | null;
  executed_at: Timestamp | null;
  propose_tx_hash: Bytes | null;
  execute_tx_hash: Bytes | null;
  failure_reason: string | null;
  /** P15: RotationTimelock de la propuesta (null en filas anteriores: el del sistema). */
  timelock: Bytes | null;
}

/** P15: eventos de RotationTimelock de las Safes de la plataforma (indexados con finalidad y reorgs). */
export interface RotationEventsTable {
  id: Generated<string>;
  chain_id: number;
  safe_address: Bytes;
  timelock: Bytes;
  proposal_id: Bytes;
  kind: 'PROPOSED' | 'CANCELLED' | 'EXECUTED';
  rotation_kind: number | null;
  old_value: Bytes | null;
  new_value: Bytes | null;
  executable_at: Timestamp | null;
  actor: Bytes | null;
  tx_hash: Bytes;
  log_index: number;
  block_number: Int8;
  block_hash: Bytes;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'REORGED';
  applied_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** P15: caso de migración excepcional (doble aprobación de operadores). */
export interface MigrationCasesTable {
  id: Generated<string>;
  old_wallet_id: string;
  new_wallet_id: string | null;
  user_id: string;
  healthy_role: 'U' | 'R';
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED';
  requested_by: string;
  approval_action_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
}

export interface TokenTransfersTable {
  id: Generated<string>;
  chain_id: number;
  safe_address: Bytes;
  token: Bytes;
  direction: 'IN' | 'OUT';
  counterparty: Bytes;
  amount: Numeric;
  tx_hash: Bytes;
  log_index: number;
  block_number: Int8;
  block_hash: Bytes;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'REORGED';
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Ejecución de una Safe indexada desde los eventos de SafeL2 (P13.T07). */
export interface SafeExecutionsTable {
  id: Generated<string>;
  chain_id: number;
  safe_address: Bytes;
  safe_nonce: Numeric;
  safe_tx_hash: Bytes;
  success: boolean;
  origin: 'PLATFORM' | 'SOVEREIGN';
  operation_id: string | null;
  target: Bytes;
  value: Numeric;
  data: Bytes;
  operation: number;
  sender: Bytes;
  tx_hash: Bytes;
  log_index: number;
  block_number: Int8;
  block_hash: Bytes;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED' | 'REORGED';
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Último bloque procesado por un indexer (con su hash, para detectar reorgs). */
export interface ChainCursorsTable {
  name: string;
  block_number: Int8;
  block_hash: Bytes;
  updated_at: GeneratedTimestamp;
}

export interface AuditEventsTable {
  id: Int8;
  occurred_at: Timestamp;
  actor_type: AuditActorType;
  actor_id: string | null;
  user_id: string | null;
  wallet_id: string | null;
  session_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip_prefix: string | null;
  payload: Json;
  prev_hash: Bytes;
  entry_hash: Bytes;
}

export interface AuditChainLockTable {
  id: Generated<boolean>;
}

export interface OutboxEventsTable {
  id: GeneratedInt8;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Json;
  created_at: GeneratedTimestamp;
  dispatched_at: Timestamp | null;
  attempts: Generated<number>;
  last_error: string | null;
  processed_at: Timestamp | null;
}

export interface IdempotencyKeysTable {
  user_id: string;
  key: string;
  request_hash: Bytes;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_body: Json | null;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  wallet_id: string | null;
  type: string;
  payload: GeneratedJson;
  read_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  /** P14: una sola notificación por evento (p. ej. `HIGH_VALUE_EXECUTED:<operación>`). */
  dedupe_key: string | null;
}

export interface OperatorUsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  totp_secret_ciphertext: Bytes;
  status: Generated<'ACTIVE' | 'DISABLED'>;
  created_at: GeneratedTimestamp;
  /** P15: último paso TOTP aceptado (anti-replay). */
  totp_last_used_step: Int8 | null;
}

export interface OperatorActionsTable {
  id: Generated<string>;
  action_type: string;
  wallet_id: string | null;
  payload: GeneratedJson;
  approver_1: string;
  approver_2: string;
  created_at: GeneratedTimestamp;
}

export interface PolicySnapshotsTable {
  version: number;
  sha256: Bytes;
  signature: Bytes;
  payload: Json;
  activated_at: Timestamp | null;
}

export interface IntegrityStatusTable {
  id: GeneratedInt8;
  app: 'WALLET' | 'RECOVERY';
  release_id: string;
  status: 'OK' | 'MISMATCH' | 'UNREACHABLE';
  details: GeneratedJson;
  observed_at: Timestamp;
}

export interface GasTopupsTable {
  id: Generated<string>;
  executor_address: Bytes;
  amount_wei: Numeric;
  tx_id: string;
  reason: string;
  created_at: GeneratedTimestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  platform_sessions: PlatformSessionsTable;
  opaque_records: OpaqueRecordsTable;
  totp_factors: TotpFactorsTable;
  wallets: WalletsTable;
  wallet_keys_metadata: WalletKeysMetadataTable;
  recovery_metadata: RecoveryMetadataTable;
  signer_keys: SignerKeysTable;
  security_challenges: SecurityChallengesTable;
  whitelist_requests: WhitelistRequestsTable;
  whitelisted_destinations: WhitelistedDestinationsTable;
  whitelist_events: WhitelistEventsTable;
  operation_groups: OperationGroupsTable;
  wallet_operations: WalletOperationsTable;
  chain_transactions: ChainTransactionsTable;
  rotation_requests: RotationRequestsTable;
  rotation_events: RotationEventsTable;
  migration_cases: MigrationCasesTable;
  token_transfers: TokenTransfersTable;
  safe_executions: SafeExecutionsTable;
  chain_cursors: ChainCursorsTable;
  audit_events: AuditEventsTable;
  audit_chain_lock: AuditChainLockTable;
  outbox_events: OutboxEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  notifications: NotificationsTable;
  operator_users: OperatorUsersTable;
  operator_actions: OperatorActionsTable;
  policy_snapshots: PolicySnapshotsTable;
  integrity_status: IntegrityStatusTable;
  gas_topups: GasTopupsTable;
}

export type AuditEventRow = Selectable<AuditEventsTable>;
export type NewAuditEvent = Insertable<AuditEventsTable>;
export type OutboxEventRow = Selectable<OutboxEventsTable>;
export type NewOutboxEvent = Insertable<OutboxEventsTable>;
export type IdempotencyKeyRow = Selectable<IdempotencyKeysTable>;
export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type WalletRow = Selectable<WalletsTable>;
export type NewWallet = Insertable<WalletsTable>;
export type WalletUpdate = Updateable<WalletsTable>;
