// Esquema inicial de la DB del signer [B-SIG-03]: shards, registro de claves (sin material privado), eventos de ciclo
// de vida (append-only), snapshots de policy aceptados (anti-rollback), SafeTx firmadas con la regla "a lo sumo una
// activa por (safe, nonce)", firmas de execTransaction emitidas y transacciones de la cuenta gas tank (tope diario).
import { sql, type Kysely } from 'kysely';

const STATEMENTS = [
  `CREATE DOMAIN eth_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$')`,
  `CREATE DOMAIN bytes32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$')`,
  `CREATE DOMAIN uint256 AS numeric(78, 0)
     CHECK (VALUE >= 0 AND VALUE < 115792089237316195423570985008687907853269984665640564039457584007913129639936)`,
  `CREATE DOMAIN shard_id AS text CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$')`,

  `CREATE FUNCTION signer_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.updated_at := now();
     RETURN NEW;
   END $$`,
  `CREATE FUNCTION signer_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '% es append-only: % rechazado', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
   END $$`,

  `CREATE TABLE signer_shards (
     shard_id shard_id PRIMARY KEY,
     provider text NOT NULL CHECK (provider IN ('development', 'selfhosted')),
     credential_fingerprint bytes32 NOT NULL,
     kdf_version integer NOT NULL CHECK (kdf_version >= 1),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE signer_keys (
     key_ref text PRIMARY KEY CHECK (key_ref ~ '^[a-z0-9][a-z0-9-]{0,62}:0x[0-9a-f]{40}$'),
     address eth_address NOT NULL,
     shard_id shard_id NOT NULL REFERENCES signer_shards (shard_id) ON DELETE RESTRICT,
     wallet_id uuid,
     purpose text NOT NULL CHECK (purpose IN ('EXECUTOR', 'GAS_TANK')),
     status text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED', 'BROKEN', 'MIGRATING', 'MIGRATED', 'DESTROYED')),
     kdf_version integer NOT NULL CHECK (kdf_version >= 1),
     credential_fingerprint bytes32 NOT NULL,
     attestation text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     retired_at timestamptz,
     destroy_after timestamptz,
     destroyed_at timestamptz,
     CONSTRAINT signer_keys_address_key UNIQUE (address),
     CONSTRAINT signer_keys_purpose_wallet CHECK ((purpose = 'GAS_TANK') = (wallet_id IS NULL)),
     CONSTRAINT signer_keys_destroyed CHECK ((status = 'DESTROYED') = (destroyed_at IS NOT NULL))
   )`,
  `CREATE INDEX signer_keys_wallet_idx ON signer_keys (wallet_id)`,
  `CREATE UNIQUE INDEX signer_keys_one_gas_tank_key ON signer_keys (shard_id) WHERE purpose = 'GAS_TANK' AND status = 'ACTIVE'`,

  `CREATE TABLE key_events (
     id bigserial PRIMARY KEY,
     shard_id shard_id NOT NULL,
     key_ref text,
     event text NOT NULL CHECK (event ~ '^[A-Z][A-Z_]{2,63}$'),
     details jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TRIGGER key_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON key_events
     FOR EACH STATEMENT EXECUTE FUNCTION signer_reject_mutation()`,

  `CREATE TABLE policy_state (
     version integer PRIMARY KEY CHECK (version >= 1),
     sha256 bytes32 NOT NULL,
     environment text NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
     activated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TRIGGER policy_state_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON policy_state
     FOR EACH STATEMENT EXECUTE FUNCTION signer_reject_mutation()`,

  `CREATE TABLE signed_safe_txs (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     safe eth_address NOT NULL,
     wallet_id uuid NOT NULL,
     nonce uint256 NOT NULL,
     safe_tx_hash bytes32 NOT NULL,
     operation_id uuid NOT NULL,
     op_type text NOT NULL,
     owner_role text NOT NULL CHECK (owner_role IN ('U', 'R')),
     token eth_address,
     amount uint256,
     destination eth_address,
     paired_safe_tx_hash bytes32,
     status text NOT NULL CHECK (status IN ('ACTIVE', 'REPLACED', 'CONSUMED')),
     replaced_by uuid REFERENCES signed_safe_txs (id) ON DELETE RESTRICT,
     executor eth_address NOT NULL,
     submitted_at timestamptz NOT NULL,
     signed_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT signed_safe_txs_hash_key UNIQUE (safe_tx_hash),
     CONSTRAINT signed_safe_txs_replaced CHECK (replaced_by IS NULL OR status = 'REPLACED')
   )`,
  // [B-SIG-03] a lo sumo una SafeTx activa firmada por (safe, nonce).
  `CREATE UNIQUE INDEX signed_safe_txs_one_active ON signed_safe_txs (safe, nonce) WHERE status = 'ACTIVE'`,
  `CREATE INDEX signed_safe_txs_ledger_idx ON signed_safe_txs (safe, signed_at)`,
  `CREATE TRIGGER signed_safe_txs_no_delete BEFORE DELETE OR TRUNCATE ON signed_safe_txs
     FOR EACH STATEMENT EXECUTE FUNCTION signer_reject_mutation()`,

  `CREATE TABLE exec_signatures (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     signed_safe_tx_id uuid NOT NULL REFERENCES signed_safe_txs (id) ON DELETE RESTRICT,
     account_nonce uint256 NOT NULL,
     tx_hash bytes32 NOT NULL,
     max_fee_per_gas uint256 NOT NULL,
     max_priority_fee_per_gas uint256 NOT NULL,
     gas_limit uint256 NOT NULL,
     signed_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT exec_signatures_tx_hash_key UNIQUE (tx_hash)
   )`,
  `CREATE TRIGGER exec_signatures_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON exec_signatures
     FOR EACH STATEMENT EXECUTE FUNCTION signer_reject_mutation()`,

  `CREATE TABLE platform_txs (
     id uuid PRIMARY KEY DEFAULT uuidv7(),
     purpose text NOT NULL CHECK (purpose IN ('TOPUP', 'DEPLOY', 'CANCEL_RELAY')),
     from_address eth_address NOT NULL,
     to_address eth_address NOT NULL,
     value_wei uint256 NOT NULL,
     account_nonce uint256 NOT NULL,
     tx_hash bytes32 NOT NULL,
     max_fee_per_gas uint256 NOT NULL,
     gas_limit uint256 NOT NULL,
     reference text,
     signed_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT platform_txs_tx_hash_key UNIQUE (tx_hash)
   )`,
  `CREATE INDEX platform_txs_daily_idx ON platform_txs (purpose, signed_at)`,
  `CREATE TRIGGER platform_txs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_txs
     FOR EACH STATEMENT EXECUTE FUNCTION signer_reject_mutation()`,
];

const UPDATED_AT_TABLES = ['signer_shards', 'signer_keys', 'signed_safe_txs'];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  for (const table of UPDATED_AT_TABLES) {
    await sql
      .raw(
        `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION signer_set_updated_at()`,
      )
      .execute(db);
  }
}
