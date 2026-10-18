// Lease de ejecución por Safe con fencing [B-NONCE-04] (P13.T02). Un solo worker procesa una Safe a la vez:
//
//   UPDATE wallets SET exec_lease_owner = $w, exec_lease_expires_at = now() + ttl, exec_lease_version = version + 1
//   WHERE id = $1 AND (exec_lease_expires_at IS NULL OR exec_lease_expires_at < now() OR exec_lease_owner = $w)
//   RETURNING exec_lease_version
//
// La versión devuelta es el token de fencing: el worker la copia en `wallet_operations.lease_version` al tomar una
// operación y toda escritura posterior la exige (OperationStateMachine con `leaseVersion`). Un worker que perdió el
// lease (pausa, partición, GC largo) falla en su primera escritura y aborta sin efectos. Nada depende de la memoria
// del worker: el estado vive en la DB y otro worker retoma desde ahí cuando el lease vence.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';

export interface LeaseOptions {
  /** Duración del lease (30 s por defecto). */
  ttlMs?: number;
}

export class SafeLease {
  readonly owner: string;
  readonly ttlMs: number;
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>, owner: string, options: LeaseOptions = {}) {
    if (owner.length === 0 || owner.length > 200) throw new TypeError('owner del lease inválido');
    this.#db = db;
    this.owner = owner;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  #interval() {
    return sql<Date>`now() + make_interval(secs => ${this.ttlMs / 1000})`;
  }

  /** Toma (o renueva siendo el dueño) el lease de la Safe; null si otro worker lo tiene vigente. */
  async acquire(walletId: string): Promise<bigint | null> {
    const row = await this.#db
      .updateTable('wallets')
      .set({
        exec_lease_owner: this.owner,
        exec_lease_expires_at: this.#interval(),
        exec_lease_version: sql`exec_lease_version + 1`,
      })
      .where('id', '=', walletId)
      .where((eb) =>
        eb.or([
          eb('exec_lease_expires_at', 'is', null),
          eb('exec_lease_expires_at', '<', sql<Date>`now()`),
          eb('exec_lease_owner', '=', this.owner),
        ]),
      )
      .returning('exec_lease_version')
      .executeTakeFirst();
    return row ? BigInt(row.exec_lease_version) : null;
  }

  /** Extiende el lease vigente sin cambiar la versión; false si ya no es de este worker. */
  async renew(walletId: string, version: bigint): Promise<boolean> {
    const result = await this.#db
      .updateTable('wallets')
      .set({ exec_lease_expires_at: this.#interval() })
      .where('id', '=', walletId)
      .where('exec_lease_owner', '=', this.owner)
      .where('exec_lease_version', '=', version.toString())
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Libera el lease (sólo si sigue siendo el vigente de este worker). */
  async release(walletId: string, version: bigint): Promise<void> {
    await this.#db
      .updateTable('wallets')
      .set({ exec_lease_owner: null, exec_lease_expires_at: null })
      .where('id', '=', walletId)
      .where('exec_lease_owner', '=', this.owner)
      .where('exec_lease_version', '=', version.toString())
      .execute();
  }
}
