// P13.T01 [B-SM-01..03]: máquina de estados de wallet_operations sobre PostgreSQL real. Las 225 combinaciones
// origen → destino (las permitidas transicionan con su evento OPERATION_<ESTADO>; las prohibidas se rechazan sin tocar
// la base), conflicto por estado y por lease (fencing), atomicidad con auditoría y outbox, y una sola ganadora entre
// transiciones concurrentes.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../../src/audit/audit-writer.ts';
import { Secret } from '../../src/config/secret.ts';
import { OutboxRepository, UnroutedOutboxEventError } from '../../src/db/repositories/outbox-repository.ts';
import type { OperationStatus } from '../../src/db/schema.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  isAllowedTransition,
  OPERATION_STATUSES,
  OperationStateMachine,
  TERMINAL_STATUSES,
  TransitionConflictError,
} from '../../src/operations/state-machine.ts';
import {
  createTestDatabase,
  insertPlatformSession,
  insertUser,
  signedEnvelopeColumns,
  type TestDatabase,
} from '../helpers/db.ts';

let db: TestDatabase;
let machine: OperationStateMachine;
let userId: string;
let wallet: { id: string; safe: Buffer };
let platformSessionId: string;
let nonce = 0;

/**
 * El diagrama de §7.4, escrito aparte de la tabla del código (que no puede derivar sola), con QUEUED → FAILED_FINAL
 * (NoOp que perdió la carrera de cancelación, [B-NONCE-06]; firma de más de 24 h, [B-PSES-06]) y REORGED → MINED (la
 * misma tx re-incluida en otro bloque).
 */
const DIAGRAM: [OperationStatus, OperationStatus][] = [
  ['QUEUED', 'FAILED_FINAL'],
  ['REORGED', 'MINED'],
  // Agregada en P14: la mitad firmada de un par approve/swap que no se completó (sin co-firma de S).
  ['USER_SIGNED', 'FAILED_FINAL'],
  ['CREATED', 'USER_SIGNED'],
  ['CREATED', 'EXPIRED'],
  ['CREATED', 'CANCELLED'],
  ['USER_SIGNED', 'QUEUED'],
  ['QUEUED', 'VALIDATING'],
  ['VALIDATING', 'READY'],
  ['VALIDATING', 'FAILED_RETRYABLE'],
  ['VALIDATING', 'FAILED_FINAL'],
  ['FAILED_RETRYABLE', 'QUEUED'],
  ['FAILED_RETRYABLE', 'FAILED_FINAL'],
  ['READY', 'SUBMITTED'],
  ['READY', 'FAILED_RETRYABLE'],
  ['READY', 'FAILED_FINAL'],
  ['SUBMITTED', 'MINED'],
  ['SUBMITTED', 'FAILED_RETRYABLE'],
  ['SUBMITTED', 'FAILED_FINAL'],
  ['MINED', 'CONFIRMED'],
  ['CONFIRMED', 'FINALIZED'],
  ['MINED', 'REORGED'],
  ['CONFIRMED', 'REORGED'],
  ['REORGED', 'QUEUED'],
  ['USER_SIGNED', 'CANCEL_REQUESTED'],
  ['QUEUED', 'CANCEL_REQUESTED'],
  ['READY', 'CANCEL_REQUESTED'],
  ['SUBMITTED', 'CANCEL_REQUESTED'],
  ['FAILED_RETRYABLE', 'CANCEL_REQUESTED'],
  ['FAILED_FINAL', 'CANCEL_REQUESTED'],
  ['CANCEL_REQUESTED', 'CANCELLED'],
  ['CANCEL_REQUESTED', 'MINED'],
];

const UNSIGNED: readonly OperationStatus[] = ['CREATED'];

async function insertOperation(status: OperationStatus, values: Record<string, unknown> = {}): Promise<string> {
  const signed = !UNSIGNED.includes(status);
  const row = await db.app
    .insertInto('wallet_operations')
    .values({
      user_id: userId,
      wallet_id: wallet.id,
      safe_address: wallet.safe,
      chain_id: 8453,
      safe_nonce: nonce++,
      operation_type: 'NOOP_CANCEL',
      safe_tx_hash: randomBytes(32),
      target: wallet.safe,
      calldata: Buffer.alloc(0),
      canonical_intent: JSON.stringify({ type: 'NOOP_CANCEL' }),
      status,
      expires_at: status === 'CREATED' ? new Date(Date.now() + 15 * 60_000) : null,
      ...(signed
        ? { ...signedEnvelopeColumns(platformSessionId), owner_signature: randomBytes(65), owner_role: 'U' }
        : {}),
      ...values,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const signaturePatch = () => ({
  ...signedEnvelopeColumns(platformSessionId),
  owner_signature: randomBytes(65),
  owner_role: 'U' as const,
});

async function statusOf(id: string): Promise<OperationStatus> {
  const row = await db.app
    .selectFrom('wallet_operations')
    .select('status')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function auditOf(id: string) {
  return db.app
    .selectFrom('audit_events')
    .select(['event_type', 'payload', 'actor_type', 'wallet_id', 'user_id'])
    .where('target_type', '=', 'operation')
    .where('target_id', '=', id)
    .orderBy('id')
    .execute();
}

async function outboxOf(id: string) {
  return db.app
    .selectFrom('outbox_events')
    .select(['event_type', 'payload'])
    .where('aggregate_type', '=', 'operation')
    .where('aggregate_id', '=', id)
    .execute();
}

beforeAll(async () => {
  db = await createTestDatabase();
  userId = await insertUser(db.app);
  const safe = randomBytes(20);
  const row = await db.app
    .insertInto('wallets')
    .values({ user_id: userId, platform_id: 'mt-test', chain_id: 8453, status: 'ACTIVE', safe_address: safe })
    .returning('id')
    .executeTakeFirstOrThrow();
  wallet = { id: row.id, safe };
  platformSessionId = await insertPlatformSession(db.app, userId, { walletId: row.id });
  machine = new OperationStateMachine({
    db: db.app,
    audit: new AuditWriter(new Secret(randomBytes(32))),
    outbox: new OutboxRepository(db.app),
  });
});

afterAll(async () => {
  await db.close();
});

describe('tabla de transiciones', () => {
  it('coincide exactamente con el diagrama de §7.4', () => {
    const fromTable = OPERATION_STATUSES.flatMap((from) => ALLOWED_TRANSITIONS[from].map((to) => `${from}→${to}`));
    expect(fromTable.sort()).toEqual(DIAGRAM.map(([from, to]) => `${from}→${to}`).sort());
  });

  it('los terminales no salen salvo FAILED_FINAL → CANCEL_REQUESTED (NoOp con la firma vigente)', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'EXPIRED', 'FAILED_FINAL', 'FINALIZED']);
    for (const terminal of TERMINAL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual(terminal === 'FAILED_FINAL' ? ['CANCEL_REQUESTED'] : []);
    }
    expect(OPERATION_STATUSES.some((from) => isAllowedTransition(from, 'CREATED'))).toBe(false);
  });
});

describe('las 225 combinaciones origen → destino contra la base', () => {
  const pairs = OPERATION_STATUSES.flatMap((from) => OPERATION_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', async (from, to) => {
    const id = await insertOperation(from);
    const input = {
      operationId: id,
      from: [from],
      to,
      actor: { type: 'WORKER' as const, id: 'worker-test' },
      ...(UNSIGNED.includes(from) && !UNSIGNED.includes(to) && to !== 'EXPIRED' && to !== 'CANCELLED'
        ? { patch: signaturePatch() }
        : {}),
    };
    if (isAllowedTransition(from, to)) {
      const result = await machine.transition(input);
      expect(result).toMatchObject({ operationId: id, from, to, walletId: wallet.id, userId });
      expect(await statusOf(id)).toBe(to);
      const audit = await auditOf(id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event_type: `OPERATION_${to}`,
        actor_type: 'WORKER',
        wallet_id: wallet.id,
        user_id: userId,
        payload: { from, to },
      });
    } else {
      await expect(machine.transition(input)).rejects.toBeInstanceOf(InvalidTransitionError);
      expect(await statusOf(id)).toBe(from);
      expect(await auditOf(id)).toHaveLength(0);
    }
  });
});

describe('transitionOperation', () => {
  const actor = { type: 'WORKER' as const, id: 'w-1' };

  it('estado distinto del esperado: conflicto sin efectos (ni auditoría ni outbox)', async () => {
    const id = await insertOperation('READY');
    await expect(
      machine.transition({
        operationId: id,
        from: ['QUEUED'],
        to: 'VALIDATING',
        actor,
        outbox: { eventType: 'OPERATION_QUEUED' },
      }),
    ).rejects.toBeInstanceOf(TransitionConflictError);
    expect(await statusOf(id)).toBe('READY');
    expect(await auditOf(id)).toHaveLength(0);
    expect(await outboxOf(id)).toHaveLength(0);
  });

  it('varios estados de origen: transiciona desde el vigente y lo audita', async () => {
    const id = await insertOperation('FAILED_RETRYABLE');
    const result = await machine.transition({
      operationId: id,
      from: ['USER_SIGNED', 'QUEUED', 'FAILED_RETRYABLE'],
      to: 'CANCEL_REQUESTED',
      actor: { type: 'USER', id: userId },
      requestId: 'req-1',
      detail: { reason: 'USER_REQUESTED' },
    });
    expect(result.from).toBe('FAILED_RETRYABLE');
    const [event] = await auditOf(id);
    expect(event).toMatchObject({
      event_type: 'OPERATION_CANCEL_REQUESTED',
      actor_type: 'USER',
      payload: { from: 'FAILED_RETRYABLE', to: 'CANCEL_REQUESTED', reason: 'USER_REQUESTED' },
    });
  });

  it('una lista de origen con una transición prohibida se rechaza entera', async () => {
    const id = await insertOperation('QUEUED');
    await expect(
      machine.transition({ operationId: id, from: ['QUEUED', 'MINED'], to: 'VALIDATING', actor }),
    ).rejects.toThrow(/MINED → VALIDATING/);
    await expect(machine.transition({ operationId: id, from: [], to: 'VALIDATING', actor })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(await statusOf(id)).toBe('QUEUED');
  });

  it('operación inexistente: conflicto', async () => {
    await expect(
      machine.transition({
        operationId: '01890000-0000-7000-8000-000000000000',
        from: ['QUEUED'],
        to: 'VALIDATING',
        actor,
      }),
    ).rejects.toBeInstanceOf(TransitionConflictError);
  });

  it('fencing [B-NONCE-04]: sólo el lease vigente transiciona', async () => {
    const id = await insertOperation('VALIDATING', { lease_version: 5 });
    await expect(
      machine.transition({ operationId: id, from: ['VALIDATING'], to: 'READY', actor, leaseVersion: 4n }),
    ).rejects.toBeInstanceOf(TransitionConflictError);
    expect(await statusOf(id)).toBe('VALIDATING');
    expect(await auditOf(id)).toHaveLength(0);
    await machine.transition({ operationId: id, from: ['VALIDATING'], to: 'READY', actor, leaseVersion: 5n });
    expect(await statusOf(id)).toBe('READY');
  });

  it('aplica el patch junto con el estado y escribe el outbox en la misma transacción', async () => {
    const id = await insertOperation('USER_SIGNED');
    await machine.transition({
      operationId: id,
      from: ['USER_SIGNED'],
      to: 'QUEUED',
      actor: { type: 'USER', id: userId },
      patch: { policy_snapshot_version: 3, last_error_code: null },
      outbox: { eventType: 'OPERATION_QUEUED', payload: { operationId: id } },
    });
    const row = await db.app
      .selectFrom('wallet_operations')
      .select(['status', 'policy_snapshot_version'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'QUEUED', policy_snapshot_version: 3 });
    expect(await outboxOf(id)).toEqual([{ event_type: 'OPERATION_QUEUED', payload: { operationId: id } }]);

    const txHash = randomBytes(32);
    const ready = await insertOperation('READY');
    await machine.transition({
      operationId: ready,
      from: ['READY'],
      to: 'SUBMITTED',
      actor,
      patch: { tx_hash: txHash, submitted_at: new Date(), s_signature: randomBytes(65) },
    });
    const submitted = await db.app
      .selectFrom('wallet_operations')
      .select(['tx_hash', 'submitted_at'])
      .where('id', '=', ready)
      .executeTakeFirstOrThrow();
    expect(submitted.tx_hash?.equals(txHash)).toBe(true);
    expect(submitted.submitted_at).toBeInstanceOf(Date);
  });

  it('atomicidad: si falla el outbox no queda ni el cambio de estado ni la auditoría', async () => {
    const id = await insertOperation('USER_SIGNED');
    await expect(
      machine.transition({
        operationId: id,
        from: ['USER_SIGNED'],
        to: 'QUEUED',
        actor,
        outbox: { eventType: 'EVENTO_SIN_COLA' },
      }),
    ).rejects.toBeInstanceOf(UnroutedOutboxEventError);
    expect(await statusOf(id)).toBe('USER_SIGNED');
    expect(await auditOf(id)).toHaveLength(0);
  });

  it('dentro de la transacción del llamador: un rollback deshace la transición', async () => {
    const id = await insertOperation('QUEUED');
    await expect(
      withTransaction(
        db.app,
        async (trx) => {
          await machine.transitionIn(trx, { operationId: id, from: ['QUEUED'], to: 'VALIDATING', actor });
          throw new Error('falla posterior del llamador');
        },
        { auditLock: true },
      ),
    ).rejects.toThrow('falla posterior del llamador');
    expect(await statusOf(id)).toBe('QUEUED');
    expect(await auditOf(id)).toHaveLength(0);
  });

  it('transiciones concurrentes desde el mismo estado: exactamente una gana [B-NONCE-07]', async () => {
    const id = await insertOperation('QUEUED');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        machine.transition({
          operationId: id,
          from: ['QUEUED'],
          to: 'VALIDATING',
          actor: { type: 'WORKER', id: `w-${String(i)}` },
        }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.every((r) => r.reason instanceof TransitionConflictError)).toBe(true);
    expect(await auditOf(id)).toHaveLength(1);
  });

  it('el índice de nonces activos sigue vigente: una cancelación saca la operación y la NoOp ocupa el nonce', async () => {
    const original = await insertOperation('SUBMITTED');
    const { safe_nonce: safeNonce } = await db.app
      .selectFrom('wallet_operations')
      .select('safe_nonce')
      .where('id', '=', original)
      .executeTakeFirstOrThrow();
    await machine.transition({ operationId: original, from: ['SUBMITTED'], to: 'CANCEL_REQUESTED', actor });
    const noop = await insertOperation('QUEUED', { safe_nonce: safeNonce, cancels_operation_id: original });
    // Si la original se mina primero, la NoOp sale del índice ("demasiado tarde") antes de que la original vuelva.
    await expect(
      machine.transition({ operationId: original, from: ['CANCEL_REQUESTED'], to: 'MINED', actor }),
    ).rejects.toMatchObject({ code: '23505' });
    await machine.transition({
      operationId: noop,
      from: ['QUEUED'],
      to: 'FAILED_FINAL',
      actor,
      patch: { failure_reason: 'CANCEL_TOO_LATE' },
    });
    await machine.transition({ operationId: original, from: ['CANCEL_REQUESTED'], to: 'MINED', actor });
    expect(await statusOf(original)).toBe('MINED');
    const count = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM wallet_operations
      WHERE wallet_id = ${wallet.id} AND safe_nonce = ${safeNonce} AND status = 'MINED'`.execute(db.app);
    expect(count.rows[0]?.n).toBe(1);
  });
});
