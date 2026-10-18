// Anti-rollback del snapshot de policy en el backend [B-POL-01]: cada proceso registra al arrancar el snapshot que
// cargó en `policy_snapshots`. Se rechaza una versión menor a la máxima registrada y una versión ya registrada con
// otro contenido (sha256 distinto): un snapshot viejo o adulterado nunca vuelve a quedar vigente.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { PolicySnapshotError, type LoadedPolicySnapshot } from './snapshot.ts';

export class PolicySnapshotStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async activate(snapshot: LoadedPolicySnapshot): Promise<void> {
    const sha256 = Buffer.from(snapshot.sha256.slice(2), 'hex');
    await withTransaction(this.#db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('mtw:policy-snapshots', 0))`.execute(trx);
      const existing = await trx
        .selectFrom('policy_snapshots')
        .select(['sha256', 'activated_at'])
        .where('version', '=', snapshot.version)
        .executeTakeFirst();
      if (existing) {
        if (!existing.sha256.equals(sha256)) {
          throw new PolicySnapshotError(`la versión ${String(snapshot.version)} ya está registrada con otro contenido`);
        }
        if (existing.activated_at === null) {
          await trx
            .updateTable('policy_snapshots')
            .set({ activated_at: sql`now()` })
            .where('version', '=', snapshot.version)
            .execute();
        }
        return;
      }
      const max = await trx
        .selectFrom('policy_snapshots')
        .select(sql<number | null>`max(version)`.as('max'))
        .executeTakeFirstOrThrow();
      if (max.max !== null && snapshot.version < max.max) {
        throw new PolicySnapshotError(
          `snapshot de policy v${String(snapshot.version)} menor a la vigente v${String(max.max)} (anti-rollback)`,
        );
      }
      await trx
        .insertInto('policy_snapshots')
        .values({
          version: snapshot.version,
          sha256,
          signature: snapshot.signature,
          payload: JSON.stringify(snapshot.payload),
          activated_at: sql`now()`,
        })
        .execute();
    });
  }

  /** Versión vigente registrada (la mayor), o null si todavía no hay ninguna. */
  async currentVersion(): Promise<number | null> {
    const row = await this.#db
      .selectFrom('policy_snapshots')
      .select(sql<number | null>`max(version)`.as('max'))
      .executeTakeFirstOrThrow();
    return row.max;
  }
}
