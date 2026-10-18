// P13.T09 (ADR-019, [B-Q-05]): sin batching; el worker procesa Safes distintas en paralelo y una misma Safe en orden
// estricto de nonce. Con minado por intervalos (1 bloque por segundo) cada operación tarda al menos un bloque: tres
// operaciones por Safe en dos Safes terminan en el tiempo de tres bloques (no de seis) si las Safes avanzan en
// paralelo, y dentro de cada Safe la operación k+1 empieza a validarse recién cuando la k ya se minó.
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
let a: ActiveWallet;
let b: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.parallelism });
  [a, b] = [await activeWallet(env), await activeWallet(env)];
}, 900_000);

afterAll(async () => {
  await env.chain.rpc('evm_setIntervalMining', [0]);
  await env.chain.setAutomine(true);
  await env.close();
});

async function timeline(operationId: string): Promise<Record<string, number>> {
  const rows = await env.base.db.app
    .selectFrom('audit_events')
    .select(['event_type', 'occurred_at'])
    .where('target_type', '=', 'operation')
    .where('target_id', '=', operationId)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.event_type, r.occurred_at.getTime()]));
}

describe('paralelismo del worker', () => {
  it('dos Safes avanzan en paralelo; dentro de cada Safe, en orden de nonce y de a una', async () => {
    const opsA: PreparedOperation[] = [];
    const opsB: PreparedOperation[] = [];
    for (let i = 0; i < 3; i++) {
      opsA.push(await queueOperation(env, a, noopCall(a)));
      opsB.push(await queueOperation(env, b, noopCall(b)));
    }
    await env.chain.setAutomine(false);
    await env.chain.rpc('evm_setIntervalMining', [1]);
    const worker = startWorker(env, { concurrency: 4 });
    try {
      await until(async () => {
        const statuses = await Promise.all([...opsA, ...opsB].map((o) => statusOf(env, o.operationId)));
        return statuses.every((s) => s === 'MINED') ? true : undefined;
      }, 120_000);
    } finally {
      await worker.stop();
      await env.chain.rpc('evm_setIntervalMining', [0]);
      await env.chain.setAutomine(true);
    }
    const ta = await Promise.all(opsA.map((o) => timeline(o.operationId)));
    const tb = await Promise.all(opsB.map((o) => timeline(o.operationId)));
    for (const t of [...ta, ...tb]) {
      expect(t.OPERATION_VALIDATING).toBeDefined();
      expect(t.OPERATION_MINED).toBeDefined();
    }
    // Dentro de cada Safe: la siguiente empieza cuando la anterior ya está minada.
    for (const t of [ta, tb]) {
      for (let i = 1; i < t.length; i++) {
        expect(t[i]?.OPERATION_VALIDATING ?? 0).toBeGreaterThanOrEqual(t[i - 1]?.OPERATION_MINED ?? Infinity);
      }
    }
    // Entre Safes: las ventanas de procesamiento se superponen (no se procesan una después de la otra).
    const window = (t: Record<string, number>[]) => ({
      start: t[0]?.OPERATION_VALIDATING ?? 0,
      end: t.at(-1)?.OPERATION_MINED ?? 0,
    });
    const wa = window(ta);
    const wb = window(tb);
    expect(Math.max(wa.start, wb.start)).toBeLessThan(Math.min(wa.end, wb.end));
    // Y el total se parece al de una sola Safe (3 bloques), no al de las dos en serie (6 bloques).
    const total = Math.max(wa.end, wb.end) - Math.min(wa.start, wb.start);
    const single = Math.max(wa.end - wa.start, wb.end - wb.start);
    expect(total).toBeLessThan(single * 1.6);
    // Los nonces se consumieron en orden.
    const blocksA = await Promise.all(
      opsA.map(async (o) =>
        BigInt(
          (
            await env.base.db.app
              .selectFrom('wallet_operations')
              .select('block_number')
              .where('id', '=', o.operationId)
              .executeTakeFirstOrThrow()
          ).block_number ?? '0',
        ),
      ),
    );
    expect([...blocksA].sort((x, y) => (x < y ? -1 : 1))).toEqual(blocksA);
  });
});
