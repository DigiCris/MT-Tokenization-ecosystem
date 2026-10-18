// P13.TST.a: requests duplicados e idempotencia en las escrituras de operaciones (POST /operations/{id}/signatures y
// /cancel). La misma Idempotency-Key con el mismo body devuelve la misma respuesta (Idempotent-Replayed) sin repetir el
// efecto (una sola transición, un solo evento de outbox, una sola NoOp); con otro body → 422; sin clave → 400; dos
// requests simultáneos con la misma clave: uno se procesa y el otro recibe 409 o la respuesta ya registrada.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { critical, idempotencyKey } from '../helpers/onboarding.ts';
import {
  activeWallet,
  cancelOperation,
  noopCall,
  prepare,
  queueOperation,
  revokeCall,
  sessionOf,
  startOperationsEnv,
  submissionBody,
  submitSignature,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.operationsIdempotency });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

async function count(table: 'audit_events' | 'outbox_events', operationId: string, eventType: string) {
  const column = table === 'audit_events' ? 'target_id' : 'aggregate_id';
  const row = await env.base.db.app
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where(column, '=', operationId)
    .where('event_type', '=', eventType)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe('idempotencia de las operaciones', () => {
  it('firma: misma clave y mismo body → misma respuesta sin repetir el efecto; otro body → 422; sin clave → 400', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const body = await submissionBody(wallet, prepared);
    const key = idempotencyKey();
    const first = await submitSignature(wallet, prepared.operationId, body, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await submitSignature(wallet, prepared.operationId, body, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await count('audit_events', prepared.operationId, 'OPERATION_QUEUED')).toBe(1);
    expect(await count('outbox_events', prepared.operationId, 'OPERATION_QUEUED')).toBe(1);

    const tampered = { ...body, ownerRole: 'R' };
    const reused = await submitSignature(wallet, prepared.operationId, tampered, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const url = `/api/v1/operations/${prepared.operationId}/signatures`;
    const missing = await critical(
      wallet.onboarded.user.wallet,
      sessionOf(wallet),
      `/operations/${prepared.operationId}/signatures`,
      body,
    );
    expect(missing.statusCode, url).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('cancelación: el reintento con la misma clave devuelve la misma NoOp (una sola creada)', async () => {
    const original = await queueOperation(env, wallet, revokeCall(env, wallet));
    const key = idempotencyKey();
    const first = await cancelOperation(wallet, original.operationId, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await cancelOperation(wallet, original.operationId, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const noops = await env.base.db.app
      .selectFrom('wallet_operations')
      .select('id')
      .where('cancels_operation_id', '=', original.operationId)
      .execute();
    expect(noops).toHaveLength(1);
    // Con otra clave: la cancelación ya está en curso (la NoOp vigente no se duplica).
    const other = await cancelOperation(wallet, original.operationId);
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'OPERATION_NOT_PENDING' });
  });

  it('dos envíos simultáneos con la misma clave: uno se procesa y el otro recibe 409 o la respuesta registrada', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const body = await submissionBody(wallet, prepared);
    const key = idempotencyKey();
    const responses = await Promise.all([
      submitSignature(wallet, prepared.operationId, body, key),
      submitSignature(wallet, prepared.operationId, body, key),
    ]);
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    expect(await count('audit_events', prepared.operationId, 'OPERATION_USER_SIGNED')).toBe(1);
    expect(await count('outbox_events', prepared.operationId, 'OPERATION_QUEUED')).toBe(1);
  });
});
