// Registro de claves del shard en la DB del signer [B-SIG-03]/[B-SIG-08]: dirección, wallet, propósito, estado,
// kdfVersion y fingerprint de la credencial con que se cifró cada keystore. Nunca material privado. Cada cambio de
// estado deja un evento append-only en key_events.
import { sql, type Kysely, type Transaction } from 'kysely';
import { checksumAddress, type Address } from '../crypto/keccak.ts';
import type { KeyPurpose, KeyStatus, SignerDatabase } from './schema.ts';

export interface ShardRecord {
  shardId: string;
  provider: 'development' | 'selfhosted';
  credentialFingerprint: string;
  kdfVersion: number;
}

export interface KeyRecord {
  keyRef: string;
  address: Address;
  shardId: string;
  walletId: string | null;
  purpose: KeyPurpose;
  status: KeyStatus;
  kdfVersion: number;
  credentialFingerprint: string;
  attestation: string | null;
  createdAt: Date;
  retiredAt: Date | null;
  destroyAfter: Date | null;
}

type Db = Kysely<SignerDatabase> | Transaction<SignerDatabase>;

export function keyRefOf(shardId: string, address: Address): string {
  return `${shardId}:${address.toLowerCase()}`;
}

function toRecord(row: {
  key_ref: string;
  address: string;
  shard_id: string;
  wallet_id: string | null;
  purpose: KeyPurpose;
  status: KeyStatus;
  kdf_version: number;
  credential_fingerprint: string;
  attestation: string | null;
  created_at: Date;
  retired_at: Date | null;
  destroy_after: Date | null;
}): KeyRecord {
  return {
    keyRef: row.key_ref,
    address: checksumAddress(row.address),
    shardId: row.shard_id,
    walletId: row.wallet_id,
    purpose: row.purpose,
    status: row.status,
    kdfVersion: row.kdf_version,
    credentialFingerprint: row.credential_fingerprint,
    attestation: row.attestation,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    destroyAfter: row.destroy_after,
  };
}

const KEY_COLUMNS = [
  'key_ref',
  'address',
  'shard_id',
  'wallet_id',
  'purpose',
  'status',
  'kdf_version',
  'credential_fingerprint',
  'attestation',
  'created_at',
  'retired_at',
  'destroy_after',
] as const;

export class KeyRegistry {
  readonly db: Kysely<SignerDatabase>;
  readonly shardId: string;

  constructor(db: Kysely<SignerDatabase>, shardId: string) {
    this.db = db;
    this.shardId = shardId;
  }

  async shard(db: Db = this.db): Promise<ShardRecord | undefined> {
    const row = await db
      .selectFrom('signer_shards')
      .select(['shard_id', 'provider', 'credential_fingerprint', 'kdf_version'])
      .where('shard_id', '=', this.shardId)
      .executeTakeFirst();
    return (
      row && {
        shardId: row.shard_id,
        provider: row.provider,
        credentialFingerprint: row.credential_fingerprint,
        kdfVersion: row.kdf_version,
      }
    );
  }

  async initShard(input: { provider: 'development' | 'selfhosted'; credentialFingerprint: string }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('signer_shards')
        .values({
          shard_id: this.shardId,
          provider: input.provider,
          credential_fingerprint: input.credentialFingerprint,
          kdf_version: 1,
        })
        .execute();
      await this.event(trx, null, 'SHARD_INITIALIZED', { provider: input.provider, kdfVersion: 1 });
    });
  }

  async insertKey(
    db: Db,
    input: {
      address: Address;
      walletId: string | null;
      purpose: KeyPurpose;
      kdfVersion: number;
      credentialFingerprint: string;
      /** MIGRATING para la copia de una migración entre shards (no firma hasta verificarse). */
      status?: 'ACTIVE' | 'MIGRATING';
    },
  ): Promise<KeyRecord> {
    const keyRef = keyRefOf(this.shardId, input.address);
    const row = await db
      .insertInto('signer_keys')
      .values({
        key_ref: keyRef,
        address: input.address.toLowerCase(),
        shard_id: this.shardId,
        wallet_id: input.walletId,
        purpose: input.purpose,
        status: input.status ?? 'ACTIVE',
        kdf_version: input.kdfVersion,
        credential_fingerprint: input.credentialFingerprint,
      })
      .returning(KEY_COLUMNS)
      .executeTakeFirstOrThrow();
    await this.event(db, keyRef, input.status === 'MIGRATING' ? 'KEY_MIGRATING_IN' : 'KEY_CREATED', {
      purpose: input.purpose,
      walletId: input.walletId,
    });
    return toRecord(row);
  }

  async setAttestation(keyRef: string, attestation: string): Promise<void> {
    await this.db
      .updateTable('signer_keys')
      .set({ attestation })
      .where('key_ref', '=', keyRef)
      .where('shard_id', '=', this.shardId)
      .execute();
  }

  async byRef(keyRef: string, db: Db = this.db): Promise<KeyRecord | undefined> {
    const row = await db
      .selectFrom('signer_keys')
      .select(KEY_COLUMNS)
      .where('key_ref', '=', keyRef)
      .where('shard_id', '=', this.shardId)
      .executeTakeFirst();
    return row && toRecord(row);
  }

  async byAddress(address: Address, db: Db = this.db): Promise<KeyRecord | undefined> {
    const row = await db
      .selectFrom('signer_keys')
      .select(KEY_COLUMNS)
      .where('address', '=', address.toLowerCase())
      .where('shard_id', '=', this.shardId)
      .executeTakeFirst();
    return row && toRecord(row);
  }

  async list(statuses?: readonly KeyStatus[]): Promise<KeyRecord[]> {
    let query = this.db.selectFrom('signer_keys').select(KEY_COLUMNS).where('shard_id', '=', this.shardId);
    if (statuses !== undefined) query = query.where('status', 'in', statuses);
    return (await query.orderBy('created_at').execute()).map(toRecord);
  }

  async forWallet(walletId: string): Promise<KeyRecord[]> {
    return (
      await this.db
        .selectFrom('signer_keys')
        .select(KEY_COLUMNS)
        .where('shard_id', '=', this.shardId)
        .where('wallet_id', '=', walletId)
        .orderBy('created_at')
        .execute()
    ).map(toRecord);
  }

  async gasTankKey(): Promise<KeyRecord | undefined> {
    const row = await this.db
      .selectFrom('signer_keys')
      .select(KEY_COLUMNS)
      .where('shard_id', '=', this.shardId)
      .where('purpose', '=', 'GAS_TANK')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row && toRecord(row);
  }

  async setStatus(
    keyRef: string,
    status: KeyStatus,
    event: string,
    details: Record<string, unknown> = {},
    extra: { retiredAt?: Date; destroyAfter?: Date; destroyedAt?: Date } = {},
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('signer_keys')
        .set({
          status,
          ...(extra.retiredAt === undefined ? {} : { retired_at: extra.retiredAt }),
          ...(extra.destroyAfter === undefined ? {} : { destroy_after: extra.destroyAfter }),
          ...(extra.destroyedAt === undefined ? {} : { destroyed_at: extra.destroyedAt }),
        })
        .where('key_ref', '=', keyRef)
        .where('shard_id', '=', this.shardId)
        .execute();
      await this.event(trx, keyRef, event, { status, ...details });
    });
  }

  async event(db: Db, keyRef: string | null, event: string, details: Record<string, unknown> = {}): Promise<void> {
    await db
      .insertInto('key_events')
      .values({ shard_id: this.shardId, key_ref: keyRef, event, details: JSON.stringify(details) })
      .execute();
  }

  async lastEvent(event: string): Promise<{ createdAt: Date; details: Record<string, unknown> } | undefined> {
    const row = await this.db
      .selectFrom('key_events')
      .select(['created_at', 'details'])
      .where('shard_id', '=', this.shardId)
      .where('event', '=', event)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return row && { createdAt: row.created_at, details: row.details };
  }

  /** Último evento de un tipo para una clave (p. ej. la etiqueta del HSM de una clave del provider hardware). */
  async eventFor(keyRef: string, event: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.db
      .selectFrom('key_events')
      .select('details')
      .where('shard_id', '=', this.shardId)
      .where('key_ref', '=', keyRef)
      .where('event', '=', event)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return row?.details;
  }

  /** Re-cifrado por rotación de credencial: nuevo fingerprint y kdfVersion de una clave (dentro de la transacción). */
  async recordReencryption(db: Db, keyRef: string, kdfVersion: number, fingerprint: string): Promise<void> {
    await db
      .updateTable('signer_keys')
      .set({ kdf_version: kdfVersion, credential_fingerprint: fingerprint })
      .where('key_ref', '=', keyRef)
      .where('shard_id', '=', this.shardId)
      .execute();
    await this.event(db, keyRef, 'KEY_REENCRYPTED', { kdfVersion });
  }

  async updateShardCredential(db: Db, kdfVersion: number, fingerprint: string): Promise<void> {
    await db
      .updateTable('signer_shards')
      .set({ kdf_version: kdfVersion, credential_fingerprint: fingerprint })
      .where('shard_id', '=', this.shardId)
      .execute();
    await this.event(db, null, 'SHARD_CREDENTIAL_ROTATED', { kdfVersion });
  }

  async counts(): Promise<Partial<Record<KeyStatus, number>>> {
    const rows = await this.db
      .selectFrom('signer_keys')
      .select(['status', sql<string>`count(*)`.as('n')])
      .where('shard_id', '=', this.shardId)
      .groupBy('status')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
