// P13.TST.h [B-Q-01], ADR-021: Valkey es sólo transporte. Con los eventos OPERATION_QUEUED ya publicados y sin
// consumir, un FLUSHDB borra los jobs (y el marcador de época): el dispatcher lo nota, vuelve a publicar desde Postgres
// lo publicado y no procesado, y el worker ejecuta cada operación UNA vez. Un flush con una operación en vuelo tampoco
// produce una segunda ejecución.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedOperation } from '../../src/operations/intent.ts';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  noopCall,
  queueOperation,
  startOperationsEnv,
  startWorker,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.valkeyFlush });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.chain.setAutomine(true);
  await env.close();
});

async function outboxOf(operationId: string) {
  return env.base.db.app
    .selectFrom('outbox_events')
    .select(['dispatched_at', 'processed_at', 'attempts'])
    .where('aggregate_id', '=', operationId)
    .where('event_type', '=', 'OPERATION_QUEUED')
    .execute();
}

async function executions(operationId: string): Promise<number> {
  const rows = await env.base.db.app
    .selectFrom('chain_transactions')
    .select('id')
    .where('operation_id', '=', operationId)
    .where('status', 'in', ['MINED', 'CONFIRMED', 'FINALIZED'])
    .execute();
  return rows.length;
}

describe('flush de Valkey', () => {
  it('jobs publicados y sin consumir perdidos: el dispatcher los re-publica y cada operación se ejecuta una vez', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const ops: PreparedOperation[] = [];
    for (let i = 0; i < 3; i++) ops.push(await queueOperation(env, wallet, noopCall(wallet)));
    // Publicados por el dispatcher (sin consumidor todavía).
    await until(async () => {
      const events = await Promise.all(ops.map((o) => outboxOf(o.operationId)));
      return events.every((e) => e[0]?.dispatched_at) ? true : undefined;
    });
    const waiting = await env.base.pipeline.queues['wallet-operations'].getJobCounts('waiting');
    expect(waiting.waiting).toBeGreaterThanOrEqual(3);
    await env.base.redis.flushdb();
    expect((await env.base.pipeline.queues['wallet-operations'].getJobCounts('waiting')).waiting).toBe(0);

    const worker = startWorker(env);
    try {
      await until(async () => {
        const statuses = await Promise.all(ops.map((o) => statusOf(env, o.operationId)));
        return statuses.every((s) => s === 'MINED') ? true : undefined;
      }, 120_000);
      await until(async () => {
        const events = await Promise.all(ops.map((o) => outboxOf(o.operationId)));
        return events.every((e) => e[0]?.processed_at) ? true : undefined;
      });
    } finally {
      await worker.stop();
    }
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 3n);
    for (const op of ops) expect(await executions(op.operationId)).toBe(1);
    const requeued = await env.base.pipeline.metrics.outboxRequeued.get();
    expect(requeued.values.reduce((n, v) => n + v.value, 0)).toBeGreaterThanOrEqual(3);
  });

  it('flush con una operación en vuelo: termina MINED una sola vez aunque su evento se vuelva a publicar', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.chain.setAutomine(false);
    const worker = startWorker(env, { pipeline: env.pipeline({ options: { receiptTimeoutMs: 600_000 } }) });
    try {
      await until(async () => ((await statusOf(env, prepared.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      await env.base.redis.flushdb();
      await env.chain.mine(1);
      await until(async () => ((await statusOf(env, prepared.operationId)) === 'MINED' ? true : undefined), 60_000);
      // Una segunda pasada (el evento re-publicado o el scheduler) no hace nada más.
      await worker.schedule();
      await worker.kick(wallet.walletId);
    } finally {
      await env.chain.setAutomine(true);
      await worker.stop();
    }
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    expect(await executions(prepared.operationId)).toBe(1);
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', prepared.operationId)
      .execute();
    expect(txs).toHaveLength(1);
  });
});
