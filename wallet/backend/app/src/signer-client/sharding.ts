// Sharding del signer [B-SIG-09] (P11.T08): cada wallet se asigna a un shard por hash estable de su `walletId` sobre
// los shards ACTIVOS al crearla, y la asignación se GUARDA en `signer_keys` (no se recalcula si cambian los shards).
// El alta de S la hace el shard asignado (POST /v1/keys) y el backend guarda la clave y su SignerKeyAttestation.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { getAddress, type Address } from 'viem';
import type { SignerShardEndpoint } from '../config/env.ts';
import type { Database } from '../db/schema.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { CreatedSignerKey, SignerClient } from './client.ts';

/** Shard de una wallet nueva: sha256(walletId) mod N sobre los ids activos ordenados (estable entre procesos). */
export function assignShard(walletId: string, shards: readonly SignerShardEndpoint[]): string {
  const active = shards
    .filter((s) => s.active)
    .map((s) => s.id)
    .sort();
  if (active.length === 0) throw new Error('no hay shards activos');
  const digest = createHash('sha256').update(`mtw-signer-shard-v1:${walletId.toLowerCase()}`).digest('hex');
  const index = Number(BigInt(`0x${digest}`) % BigInt(active.length));
  const id = active[index];
  if (id === undefined) throw new Error('índice de shard fuera de rango');
  return id;
}

export interface StoredSignerKey {
  walletId: string;
  shardId: string;
  keyRef: string;
  address: Address;
  attestation: string | null;
  status: 'ACTIVE' | 'PENDING' | 'RETIRED';
}

export class SignerKeyService {
  readonly #db: Kysely<Database>;
  readonly #shards: readonly SignerShardEndpoint[];
  readonly #clients: ReadonlyMap<string, SignerClient>;

  constructor(options: {
    db: Kysely<Database>;
    shards: readonly SignerShardEndpoint[];
    clients: ReadonlyMap<string, SignerClient>;
  }) {
    this.#db = options.db;
    this.#shards = options.shards;
    this.#clients = options.clients;
  }

  client(shardId: string): SignerClient {
    const client = this.#clients.get(shardId);
    if (client === undefined) throw new Error(`shard ${shardId} sin cliente configurado`);
    return client;
  }

  /** Shard de la wallet: el guardado si ya tiene clave; si no, el asignado por hash sobre los activos. */
  async shardOf(walletId: string): Promise<string> {
    const stored = await this.#db
      .selectFrom('signer_keys')
      .select('shard_id')
      .where('wallet_id', '=', walletId)
      .orderBy('created_at')
      .executeTakeFirst();
    return stored?.shard_id ?? assignShard(walletId, this.#shards);
  }

  async activeKey(walletId: string): Promise<StoredSignerKey | undefined> {
    const row = await this.#db
      .selectFrom('signer_keys')
      .select(['wallet_id', 'shard_id', 'key_ref', 'address', 'attestation', 'status'])
      .where('wallet_id', '=', walletId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row && toStored(row);
  }

  /**
   * S de onboarding: idempotente (si ya hay una S activa la devuelve); si no, la crea el shard asignado y se guarda
   * con su atestación. La asignación queda fijada por la fila guardada.
   */
  async ensureExecutor(walletId: string): Promise<StoredSignerKey> {
    const existing = await this.activeKey(walletId);
    if (existing !== undefined) return existing;
    const shardId = await this.shardOf(walletId);
    const created = await this.client(shardId).createKey({ walletId, reason: 'ONBOARDING' });
    return this.#store(walletId, shardId, created, 'ACTIVE');
  }

  /** S nueva para una rotación: mismo shard que la wallet (o el indicado), queda PENDING hasta ejecutarse on-chain. */
  async createRotationKey(walletId: string, shardId?: string): Promise<StoredSignerKey> {
    const target = shardId ?? (await this.shardOf(walletId));
    const created = await this.client(target).createKey({ walletId, reason: 'ROTATION' });
    return this.#store(walletId, target, created, 'PENDING');
  }

  /** Aplica una migración entre shards ya hecha en el signer (salida de `pnpm --dir backend/signer shard:migrate`). */
  async reassign(
    moved: readonly { walletId: string; address: string; fromShard: string; toShard: string; keyRef: string }[],
  ): Promise<number> {
    let updated = 0;
    await this.#db.transaction().execute(async (trx) => {
      for (const m of moved) {
        const result = await trx
          .updateTable('signer_keys')
          .set({ shard_id: m.toShard, key_ref: m.keyRef })
          .where('wallet_id', '=', m.walletId)
          .where('address', '=', addressToBuffer(m.address))
          .where('shard_id', '=', m.fromShard)
          .executeTakeFirst();
        updated += Number(result.numUpdatedRows);
      }
    });
    return updated;
  }

  async #store(
    walletId: string,
    shardId: string,
    created: CreatedSignerKey,
    status: 'ACTIVE' | 'PENDING',
  ): Promise<StoredSignerKey> {
    if (created.shardId !== shardId) throw new Error(`el shard ${shardId} respondió como ${created.shardId}`);
    const address = getAddress(created.address);
    await this.#db
      .insertInto('signer_keys')
      .values({
        wallet_id: walletId,
        shard_id: shardId,
        key_ref: created.keyRef,
        address: addressToBuffer(address),
        provider: 'selfhosted',
        status,
        attestation: created.attestation ?? null,
      })
      .execute();
    return { walletId, shardId, keyRef: created.keyRef, address, attestation: created.attestation ?? null, status };
  }
}

function toStored(row: {
  wallet_id: string;
  shard_id: string;
  key_ref: string;
  address: Buffer;
  attestation: string | null;
  status: 'ACTIVE' | 'PENDING' | 'RETIRED';
}): StoredSignerKey {
  return {
    walletId: row.wallet_id,
    shardId: row.shard_id,
    keyRef: row.key_ref,
    address: bufferToAddress(row.address),
    attestation: row.attestation,
    status: row.status,
  };
}
