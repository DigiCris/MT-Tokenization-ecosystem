// [B-POL-01] / P13.T10: anti-rollback del snapshot de policy en el backend. Cada proceso registra al arrancar el
// snapshot que cargó en `policy_snapshots`: la misma versión con el mismo contenido es idempotente, con otro contenido
// se rechaza, una versión menor a la máxima registrada se rechaza y una mayor queda vigente. Contra PostgreSQL real.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicySnapshotError, type LoadedPolicySnapshot } from '../../src/policy/snapshot.ts';
import { PolicySnapshotStore } from '../../src/policy/store.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

let db: TestDatabase;
let store: PolicySnapshotStore;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new PolicySnapshotStore(db.app);
});

afterAll(async () => {
  await db.close();
});

/** Snapshot cargado mínimo para el store (sólo usa versión, sha256, firma y payload). */
function loaded(version: number, content = `v${String(version)}`): LoadedPolicySnapshot {
  const payload = { version, content };
  const sha256 = `0x${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}` as const;
  return { version, sha256, signature: randomBytes(64), payload } as unknown as LoadedPolicySnapshot;
}

describe('PolicySnapshotStore', () => {
  it('sin snapshots registrados no hay versión vigente; el primero queda registrado y activo', async () => {
    expect(await store.currentVersion()).toBeNull();
    await store.activate(loaded(3));
    expect(await store.currentVersion()).toBe(3);
    const row = await db.app
      .selectFrom('policy_snapshots')
      .selectAll()
      .where('version', '=', 3)
      .executeTakeFirstOrThrow();
    expect(row.activated_at).toBeInstanceOf(Date);
    expect(row.payload).toEqual({ version: 3, content: 'v3' });
    expect(`0x${row.sha256.toString('hex')}`).toBe(loaded(3).sha256);
  });

  it('la misma versión con el mismo contenido es idempotente (varios procesos arrancando)', async () => {
    await Promise.all([store.activate(loaded(3)), store.activate(loaded(3)), store.activate(loaded(3))]);
    const rows = await db.app.selectFrom('policy_snapshots').select('version').execute();
    expect(rows).toHaveLength(1);
  });

  it('una versión ya registrada con otro contenido se rechaza (snapshot adulterado)', async () => {
    await expect(store.activate(loaded(3, 'adulterado'))).rejects.toBeInstanceOf(PolicySnapshotError);
    await expect(store.activate(loaded(3, 'adulterado'))).rejects.toThrow(/ya está registrada con otro contenido/);
  });

  it('una versión menor a la vigente se rechaza (anti-rollback); una mayor queda vigente', async () => {
    await expect(store.activate(loaded(2))).rejects.toThrow(/anti-rollback/);
    await store.activate(loaded(5));
    expect(await store.currentVersion()).toBe(5);
    await expect(store.activate(loaded(4))).rejects.toBeInstanceOf(PolicySnapshotError);
    // La anterior sigue registrada: reactivarla con su mismo contenido no la vuelve vigente.
    await store.activate(loaded(3));
    expect(await store.currentVersion()).toBe(5);
  });

  it('una fila registrada sin activar (alta manual previa) se activa al cargarla', async () => {
    const snapshot = loaded(7);
    await db.app
      .insertInto('policy_snapshots')
      .values({
        version: 7,
        sha256: Buffer.from(snapshot.sha256.slice(2), 'hex'),
        signature: snapshot.signature,
        payload: JSON.stringify(snapshot.payload),
        activated_at: null,
      })
      .execute();
    await store.activate(snapshot);
    const row = await db.app
      .selectFrom('policy_snapshots')
      .select('activated_at')
      .where('version', '=', 7)
      .executeTakeFirstOrThrow();
    expect(row.activated_at).toBeInstanceOf(Date);
  });
});
