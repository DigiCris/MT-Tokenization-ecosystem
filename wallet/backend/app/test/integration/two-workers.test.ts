// P13.TST.c / P13.T02 [B-NONCE-04/07]: dos workers sobre la misma operación. Con el lease vigente el segundo no hace
// nada; si el primero queda colgado (la respuesta del signer retenida por un proxy) y su lease vence, el segundo retoma
// la operación (auditado), la firma y la transmite; cuando el primero recibe por fin la respuesta, su escritura con
// fencing falla y aborta sin transmitir: una sola ejecución on-chain, una sola tx de S.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  auditTypes,
  noopCall,
  operationRow,
  queueOperation,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { startTcpProxy } from '../helpers/tcp-proxy.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.twoWorkers });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

async function auditActors(operationId: string): Promise<{ event: string; actor: string | null }[]> {
  const rows = await env.base.db.app
    .selectFrom('audit_events')
    .select(['event_type', 'actor_id'])
    .where('target_type', '=', 'operation')
    .where('target_id', '=', operationId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ event: r.event_type, actor: r.actor_id }));
}

describe('dos workers sobre la misma Safe', () => {
  it('con el lease vigente el segundo worker no procesa: una sola ejecución', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    const before = await env.chain.safeNonce(wallet.safe);
    const a = env.pipeline({ owner: 'worker-a' });
    const b = env.pipeline({ owner: 'worker-b' });
    await Promise.all([a.processWallet(wallet.walletId), b.processWallet(wallet.walletId)]);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    const actors = new Set(
      (await auditActors(prepared.operationId)).filter((e) => e.event === 'OPERATION_VALIDATING').map((e) => e.actor),
    );
    expect(actors.size).toBe(1);
  });

  it('el worker colgado pierde el lease: el otro retoma y transmite; el primero aborta en su escritura con fencing', async () => {
    const shard = new URL(env.base.executorShard.url);
    const proxy = await startTcpProxy({ host: shard.hostname, port: Number(shard.port) });
    try {
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      const safeBefore = await env.chain.safeNonce(wallet.safe);
      const executorBefore = BigInt(
        await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' }),
      );
      proxy.setMode('hold');
      // A: TTL largo (no llega a renovar durante el test) y el signer detrás del proxy que retiene la respuesta.
      const a = env.pipeline({
        owner: 'worker-a',
        leaseTtlMs: 120_000,
        signerUrl: `https://127.0.0.1:${String(proxy.port)}`,
      });
      const running = a.processWallet(wallet.walletId);
      // El signer ya firmó y respondió; A espera la respuesta retenida (como un proceso pausado o una partición).
      await until(() => Promise.resolve(proxy.heldBytes() > 0 ? true : undefined), 60_000);
      expect(await statusOf(env, prepared.operationId)).toBe('READY');

      // El lease de A vence (sus renovaciones no llegaron) y B toma la Safe.
      await env.base.db.app
        .updateTable('wallets')
        .set({ exec_lease_expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', wallet.walletId)
        .execute();
      await env.pipeline({ owner: 'worker-b' }).processWallet(wallet.walletId);
      expect(await statusOf(env, prepared.operationId)).toBe('MINED');

      // A recibe por fin la respuesta del signer: su escritura con fencing falla y no transmite.
      proxy.release();
      await running;
      const row = await operationRow(env, prepared.operationId);
      expect(row.status).toBe('MINED');
      const txs = await env.base.db.app
        .selectFrom('chain_transactions')
        .select(['tx_hash', 'status'])
        .where('operation_id', '=', prepared.operationId)
        .execute();
      expect(txs).toHaveLength(1);
      expect(txs[0]?.status).toBe('MINED');
      expect(await env.chain.safeNonce(wallet.safe)).toBe(safeBefore + 1n);
      const executorAfter = BigInt(
        await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' }),
      );
      expect(executorAfter).toBe(executorBefore + 1n);
      const events = await auditActors(prepared.operationId);
      expect(events).toContainEqual({ event: 'OPERATION_RECLAIMED', actor: 'worker-b' });
      expect(events.filter((e) => e.event === 'OPERATION_SUBMITTED')).toEqual([
        { event: 'OPERATION_SUBMITTED', actor: 'worker-b' },
      ]);
      expect(events.filter((e) => e.event === 'S_EXECUTION_SUBMITTED').map((e) => e.actor)).toEqual(['worker-b']);
      expect(await auditTypes(env, prepared.operationId)).not.toContain('OPERATION_FAILED_FINAL');
    } finally {
      proxy.release();
      await proxy.close();
    }
  });
});
