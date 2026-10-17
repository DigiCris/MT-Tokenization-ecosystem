// Tipos de la DB del signer (migrations/0001_initial.ts). Direcciones y hashes como texto hex en minúsculas.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Numeric = ColumnType<string, string | bigint, string | bigint>;

export type KeyPurpose = 'EXECUTOR' | 'GAS_TANK';
export type KeyStatus = 'ACTIVE' | 'RETIRED' | 'BROKEN' | 'MIGRATING' | 'MIGRATED' | 'DESTROYED';
export type SignedSafeTxStatus = 'ACTIVE' | 'REPLACED' | 'CONSUMED';
export type PlatformTxPurpose = 'TOPUP' | 'DEPLOY' | 'CANCEL_RELAY';

export interface SignerShardsTable {
  shard_id: string;
  provider: 'development' | 'selfhosted';
  credential_fingerprint: string;
  kdf_version: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SignerKeysTable {
  key_ref: string;
  address: string;
  shard_id: string;
  wallet_id: string | null;
  purpose: KeyPurpose;
  status: KeyStatus;
  kdf_version: number;
  credential_fingerprint: string;
  attestation: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  retired_at: Timestamp | null;
  destroy_after: Timestamp | null;
  destroyed_at: Timestamp | null;
}

export interface KeyEventsTable {
  id: Generated<string>;
  shard_id: string;
  key_ref: string | null;
  event: string;
  details: ColumnType<Record<string, unknown>, string, never>;
  created_at: Generated<Date>;
}

export interface PolicyStateTable {
  version: number;
  sha256: string;
  environment: string;
  activated_at: Generated<Date>;
}

export interface SignedSafeTxsTable {
  id: Generated<string>;
  safe: string;
  wallet_id: string;
  nonce: Numeric;
  safe_tx_hash: string;
  operation_id: string;
  op_type: string;
  owner_role: 'U' | 'R';
  token: string | null;
  amount: Numeric | null;
  destination: string | null;
  paired_safe_tx_hash: string | null;
  status: SignedSafeTxStatus;
  replaced_by: string | null;
  executor: string;
  submitted_at: Timestamp;
  signed_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExecSignaturesTable {
  id: Generated<string>;
  signed_safe_tx_id: string;
  account_nonce: Numeric;
  tx_hash: string;
  max_fee_per_gas: Numeric;
  max_priority_fee_per_gas: Numeric;
  gas_limit: Numeric;
  signed_at: Generated<Date>;
}

export interface PlatformTxsTable {
  id: Generated<string>;
  purpose: PlatformTxPurpose;
  from_address: string;
  to_address: string;
  value_wei: Numeric;
  account_nonce: Numeric;
  tx_hash: string;
  max_fee_per_gas: Numeric;
  gas_limit: Numeric;
  reference: string | null;
  signed_at: Generated<Date>;
}

export interface SignerDatabase {
  signer_shards: SignerShardsTable;
  signer_keys: SignerKeysTable;
  key_events: KeyEventsTable;
  policy_state: PolicyStateTable;
  signed_safe_txs: SignedSafeTxsTable;
  exec_signatures: ExecSignaturesTable;
  platform_txs: PlatformTxsTable;
}
