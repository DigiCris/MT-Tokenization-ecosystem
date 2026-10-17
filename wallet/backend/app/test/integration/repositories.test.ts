// P08.T04: límites transaccionales explícitos. withTransaction usa SERIALIZABLE por defecto y reintenta ante fallas
// de serialización reales de PostgreSQL (40001) y deadlocks (40P01); los repositorios del outbox, la auditoría y la
// idempotencia operan dentro de esos límites.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLockError, AuditWriter, verifyAuditChain } from '../../src/audit/audit-writer.ts';
import { Secret } from '../../src/config/secret.ts';
import { IdempotencyRepository } from '../../src/db/repositories/idempotency-repository.ts';
import { OutboxRepository, UnroutedOutboxEventError } from '../../src/db/repositories/outbox-repository.ts';
import { TransactionRetriesExhaustedError, withTransaction } from '../../src/db/transaction.ts';
import { createTestDatabase, insertUser, type TestDatabase } from '../helpers/db.ts';

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const done = new Promise<void>((resolveDone) => (release = resolveDone));
  return async () => {
    arrived++;
    if (arrived === parties) release();
    await done;
  };
}

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('withTransaction', () => {
  it('usa SERIALIZABLE por defecto y respeta el nivel pedido', async () => {
    const level = (isolation?: 'read committed') =>
      withTransaction(
        db.app,
        async (trx) =>
          (await sql<{ l: string }>`SELECT current_setting('transaction_isolation') AS l`.execute(trx)).rows[0]?.l,
        isolation ? { isolation } : {},
      );
    expect(await level()).toBe('serializable');
    expect(await level('read committed')).toBe('read committed');
  });

  it('reintenta ante 40001 (write skew real) y conserva el invariante', async () => {
    const userId = await insertUser(db.app);
    const wait = barrier(2);
    const attempts = { a: 0, b: 0 };
    const retries: string[] = [];
    const run = (label: 'a' | 'b') =>
      withTransaction(
        db.app,
        async (trx) => {
          attempts[label]++;
          const { n } = await trx
            .selectFrom('notifications')
            .select(sql<number>`count(*)::int`.as('n'))
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow();
          if (attempts[label] === 1) await wait();
          // Invariante: a lo sumo una notificación de bienvenida por usuario.
          if (n === 0)
            await trx.insertInto('notifications').values({ user_id: userId, type: 'WELCOME_NOTICE' }).execute();
          return n;
        },
        { onRetry: (_attempt, state) => retries.push(state) },
      );
    await Promise.all([run('a'), run('b')]);
    expect(retries).toContain('40001');
    expect(attempts.a + attempts.b).toBeGreaterThanOrEqual(3);
    const { n } = await db.app
      .selectFrom('notifications')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(n).toBe(1);
  });

  it('con un solo intento, la falla de serialización se informa como reintentos agotados', async () => {
    const userId = await insertUser(db.app);
    const wait = barrier(2);
    const run = () =>
      withTransaction(
        db.app,
        async (trx) => {
          const { n } = await trx
            .selectFrom('notifications')
            .select(sql<number>`count(*)::int`.as('n'))
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow();
          await wait();
          if (n === 0)
            await trx.insertInto('notifications').values({ user_id: userId, type: 'WELCOME_NOTICE' }).execute();
        },
        { maxAttempts: 1 },
      );
    const results = await Promise.allSettled([run(), run()]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(TransactionRetriesExhaustedError);
    expect((reason.cause as { code?: string }).code).toBe('40001');
  });

  it('reintenta ante un deadlock (40P01)', async () => {
    const [u1, u2] = [await insertUser(db.app), await insertUser(db.app)];
    const wait = barrier(2);
    const attempts = { a: 0, b: 0 };
    const retries: string[] = [];
    const run = (label: 'a' | 'b', first: string, second: string) =>
      withTransaction(
        db.app,
        async (trx) => {
          attempts[label]++;
          await trx
            .updateTable('users')
            .set({ failed_login_count: sql`failed_login_count + 1` })
            .where('id', '=', first)
            .execute();
          if (attempts[label] === 1) await wait();
          await trx
            .updateTable('users')
            .set({ failed_login_count: sql`failed_login_count + 1` })
            .where('id', '=', second)
            .execute();
        },
        { isolation: 'read committed', onRetry: (_attempt, state) => retries.push(state) },
      );
    await Promise.all([run('a', u1, u2), run('b', u2, u1)]);
    expect(retries).toEqual(['40P01']);
    const rows = await db.app.selectFrom('users').select('failed_login_count').where('id', 'in', [u1, u2]).execute();
    expect(rows.map((r) => r.failed_login_count)).toEqual([2, 2]);
  });

  it('no reintenta errores que no son de concurrencia', async () => {
    const email = `dup${randomBytes(3).toString('hex')}@test.invalid`;
    await insertUser(db.app, email);
    let attempts = 0;
    await expect(
      withTransaction(db.app, async (trx) => {
        attempts++;
        await insertUser(trx, email);
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
  });
});

describe('auditoría concurrente', () => {
  // Una sola clave de cadena para toda la base de este archivo (como en producción).
  const key = new Secret(randomBytes(32));
  const writer = new AuditWriter(key);

  it('N transacciones SERIALIZABLE concurrentes con auditLock encadenan sin bifurcaciones ni reintentos', async () => {
    const retries: string[] = [];
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        withTransaction(
          db.app,
          async (trx) => {
            await trx
              .insertInto('notifications')
              .values({ user_id: await insertUser(trx), type: 'AUDITED_CHANGE' })
              .execute();
            await writer.append(trx, { actorType: 'SYSTEM', eventType: 'TEST_CONCURRENT_APPEND', payload: { i } });
          },
          { auditLock: true, onRetry: (_attempt, state) => retries.push(state) },
        ),
      ),
    );
    expect(retries).toEqual([]);
    expect(await verifyAuditChain(db.app, key)).toMatchObject({ ok: true, count: 16 });
  });

  it('en READ COMMITTED el advisory lock alcanza y en SERIALIZABLE sin auditLock se rechaza', async () => {
    const before = await verifyAuditChain(db.app, key);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withTransaction(
          db.app,
          (trx) => writer.append(trx, { actorType: 'SYSTEM', eventType: 'TEST_READ_COMMITTED' }),
          {
            isolation: 'read committed',
          },
        ),
      ),
    );
    expect(await verifyAuditChain(db.app, key)).toMatchObject({ ok: true, count: before.count + 8 });
    await expect(
      withTransaction(db.app, (trx) => writer.append(trx, { actorType: 'SYSTEM', eventType: 'TEST_NO_LOCK' })),
    ).rejects.toBeInstanceOf(AuditLockError);
  });
});

describe('OutboxRepository', () => {
  const outbox = () => new OutboxRepository(db.app);

  it('el evento se confirma o se descarta junto con su transacción', async () => {
    const aggregateId = randomUUID();
    await expect(
      withTransaction(db.app, async (trx) => {
        await outbox().enqueue(trx, { aggregateType: 'wallet_operation', aggregateId, eventType: 'OPERATION_QUEUED' });
        throw new Error('rollback deliberado');
      }),
    ).rejects.toThrow('rollback deliberado');
    expect(
      await db.app.selectFrom('outbox_events').select('id').where('aggregate_id', '=', aggregateId).execute(),
    ).toEqual([]);

    await withTransaction(db.app, (trx) =>
      outbox().enqueue(trx, {
        aggregateType: 'wallet_operation',
        aggregateId,
        eventType: 'OPERATION_QUEUED',
        payload: { a: 1 },
      }),
    );
    const rows = await db.app.selectFrom('outbox_events').selectAll().where('aggregate_id', '=', aggregateId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'OPERATION_QUEUED',
      payload: { a: 1 },
      dispatched_at: null,
      attempts: 0,
    });
  });

  it('rechaza eventos sin cola asignada', async () => {
    await expect(
      withTransaction(db.app, (trx) =>
        outbox().enqueue(trx, {
          aggregateType: 'wallet_operation',
          aggregateId: randomUUID(),
          eventType: 'UNKNOWN_EVENT',
        }),
      ),
    ).rejects.toBeInstanceOf(UnroutedOutboxEventError);
  });

  it('dos dispatchers concurrentes toman lotes disjuntos (SKIP LOCKED)', async () => {
    await withTransaction(db.app, async (trx) => {
      for (let i = 0; i < 10; i++) {
        await outbox().enqueue(trx, {
          aggregateType: 'wallet_operation',
          aggregateId: randomUUID(),
          eventType: 'OPERATION_QUEUED',
        });
      }
    });
    const wait = barrier(2);
    const claim = () =>
      db.app.transaction().execute(async (trx) => {
        const events = await outbox().claimUndispatched(trx, 5);
        await wait();
        await outbox().markDispatched(
          trx,
          events.map((e) => e.id),
        );
        return events.map((e) => e.id);
      });
    const [a, b] = await Promise.all([claim(), claim()]);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(a.length + b.length).toBeGreaterThan(0);
  });

  it('markProcessed espera al dispatcher, es idempotente y nunca deja un evento procesado sin publicar', async () => {
    const id = await withTransaction(db.app, (trx) =>
      outbox().enqueue(trx, {
        aggregateType: 'wallet_operation',
        aggregateId: randomUUID(),
        eventType: 'OPERATION_QUEUED',
      }),
    );
    // El consumidor confirma mientras el dispatcher todavía tiene la fila tomada: espera y aplica tras su commit.
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    const dispatcherTx = db.app.transaction().execute(async (trx) => {
      await outbox().claimUndispatched(trx, 10);
      await held;
      await outbox().markDispatched(trx, [id]);
    });
    const ack = outbox().markProcessed(id);
    await new Promise((r) => setTimeout(r, 100));
    release();
    await dispatcherTx;
    expect(await ack).toBe(true);
    expect(await outbox().markProcessed('999999999')).toBe(false);
    const first = await db.app
      .selectFrom('outbox_events')
      .select(['processed_at', 'dispatched_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(first.dispatched_at).toBeInstanceOf(Date);
    expect(await outbox().markProcessed(id)).toBe(true);
    const second = await db.app
      .selectFrom('outbox_events')
      .select('processed_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(second.processed_at).toEqual(first.processed_at);

    // Si la transacción del dispatcher se perdió, la confirmación también marca el evento como publicado.
    const orphan = await withTransaction(db.app, (trx) =>
      outbox().enqueue(trx, {
        aggregateType: 'wallet_operation',
        aggregateId: randomUUID(),
        eventType: 'OPERATION_QUEUED',
      }),
    );
    expect(await outbox().markProcessed(orphan)).toBe(true);
    const row = await db.app.selectFrom('outbox_events').selectAll().where('id', '=', orphan).executeTakeFirstOrThrow();
    expect(row.dispatched_at).toBeInstanceOf(Date);
    expect(row.processed_at).toBeInstanceOf(Date);
  });
});

describe('IdempotencyRepository', () => {
  const repo = () => new IdempotencyRepository(db.app);
  const key = () => `idem_${randomBytes(12).toString('hex')}`;
  const h = (s: string) => Buffer.from(s.padEnd(32, '.').slice(0, 32));

  it('reclama, completa y repite; otra request con la misma clave es mismatch', async () => {
    const userId = await insertUser(db.app);
    const k = key();
    expect(await repo().claim(userId, k, h('a'))).toEqual({ state: 'claimed' });
    expect(await repo().claim(userId, k, h('a'))).toEqual({ state: 'in-progress' });
    await repo().complete(userId, k, 201, { id: 'x' });
    expect(await repo().claim(userId, k, h('a'))).toEqual({ state: 'replay', status: 201, body: { id: 'x' } });
    expect(await repo().claim(userId, k, h('b'))).toEqual({ state: 'mismatch' });
    // La misma clave de otro usuario es independiente.
    expect(await repo().claim(await insertUser(db.app), k, h('b'))).toEqual({ state: 'claimed' });
  });

  it('libera la clave tras un 5xx y retoma un IN_PROGRESS abandonado', async () => {
    const userId = await insertUser(db.app);
    const k = key();
    await repo().claim(userId, k, h('a'));
    await repo().release(userId, k);
    expect(await repo().claim(userId, k, h('a'))).toEqual({ state: 'claimed' });
    await sql`UPDATE idempotency_keys SET created_at = now() - interval '10 minutes' WHERE key = ${k}`.execute(db.app);
    expect(await repo().claim(userId, k, h('a'))).toEqual({ state: 'claimed' });
  });

  it('una clave vencida se puede reutilizar y la limpieza borra las viejas', async () => {
    const userId = await insertUser(db.app);
    const k = key();
    await repo().claim(userId, k, h('a'));
    await repo().complete(userId, k, 200, { ok: true });
    await sql`UPDATE idempotency_keys SET created_at = now() - interval '3 days', expires_at = now() - interval '2 days'
              WHERE key = ${k}`.execute(db.app);
    expect(await repo().deleteExpired()).toBeGreaterThanOrEqual(1);
    expect(await repo().claim(userId, k, h('z'))).toEqual({ state: 'claimed' });
  });
});
