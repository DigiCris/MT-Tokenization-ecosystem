// P13.TST.g [B-Q-04]: el proceso `worker` real muerto con kill -9 en cada etapa del pipeline y reiniciado. En todos los
// casos la operación termina MINED con UNA sola ejecución on-chain: validando (lectura RPC retenida), con la firma de S
// ya pedida al signer (respuesta retenida), entre el registro write-ahead de la tx y su transmisión (la tx nunca llegó
// al nodo: el worker nuevo la retransmite tal cual) y esperando el receipt. También el reinicio ordenado (SIGTERM) con
// eventos de la cola pendientes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFaultProxy } from '../helpers/fault-proxy.ts';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  auditTypes,
  noopCall,
  queueOperation,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { startTcpProxy } from '../helpers/tcp-proxy.ts';
import { startWorkerProcess, workerProcessEnv, type WorkerProcess } from '../helpers/worker-process.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.crashRestart });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.chain.setAutomine(true);
  await env.close();
});

async function chainTxs(operationId: string) {
  return env.base.db.app
    .selectFrom('chain_transactions')
    .select(['tx_hash', 'status'])
    .where('operation_id', '=', operationId)
    .execute();
}

/** Estado de las operaciones, del lease de la Safe y de sus eventos de outbox (para diagnosticar una falla). */
async function diagnostics(operationIds: string[]): Promise<string> {
  const ops = await env.base.db.app
    .selectFrom('wallet_operations')
    .select(['id', 'status', 'safe_nonce', 'blocked_reason', 'last_error_code', 'lease_version', 'updated_at'])
    .where('wallet_id', '=', wallet.walletId)
    .orderBy('safe_nonce')
    .execute();
  const lease = await env.base.db.app
    .selectFrom('wallets')
    .select(['exec_lease_owner', 'exec_lease_expires_at', 'exec_lease_version'])
    .where('id', '=', wallet.walletId)
    .executeTakeFirst();
  const events = await env.base.db.app
    .selectFrom('outbox_events')
    .select(['aggregate_id', 'dispatched_at', 'processed_at', 'attempts', 'last_error'])
    .where('aggregate_id', 'in', operationIds)
    .execute();
  const onchain = await env.chain.safeNonce(wallet.safe);
  return JSON.stringify({ onchain: onchain.toString(), ops, lease, events, now: new Date() });
}

/** Reinicia un worker con conexiones directas y espera MINED; verifica una sola ejecución. */
async function restartAndExpectMined(operationId: string, safeNonceBefore: bigint): Promise<void> {
  const worker = startWorkerProcess(await workerProcessEnv(env));
  try {
    await until(async () => ((await statusOf(env, operationId)) === 'MINED' ? true : undefined), 120_000).catch(
      async (error: unknown) => {
        throw new Error(
          `no llegó a MINED: ${String(error)}\n${await diagnostics([operationId])}\n${worker.output().slice(-4000)}`,
        );
      },
    );
  } finally {
    expect(await worker.kill('SIGTERM')).toBe(0);
  }
  expect(await env.chain.safeNonce(wallet.safe)).toBe(safeNonceBefore + 1n);
  const mined = (await chainTxs(operationId)).filter((t) => t.status === 'MINED');
  expect(mined).toHaveLength(1);
}

async function killWhen(worker: WorkerProcess, condition: () => Promise<boolean>): Promise<void> {
  await until(async () => ((await condition()) ? true : undefined), 120_000).catch((error: unknown) => {
    throw new Error(`condición no alcanzada: ${String(error)}\n${worker.output().slice(-4000)}`);
  });
  expect(await worker.kill('SIGKILL')).toBeNull();
}

describe('kill -9 y reinicio del worker', () => {
  it('validando (lectura on-chain retenida): el worker nuevo la retoma y la ejecuta', async () => {
    const proxy = await startFaultProxy(env.base.anvil.url);
    try {
      proxy.setMode({ kind: 'timeout', methods: ['eth_getStorageAt'] });
      const before = await env.chain.safeNonce(wallet.safe);
      const worker = startWorkerProcess(await workerProcessEnv(env, { rpcUrl: proxy.url }));
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      await killWhen(worker, async () => (await statusOf(env, prepared.operationId)) === 'VALIDATING');
      await restartAndExpectMined(prepared.operationId, before);
      expect(await auditTypes(env, prepared.operationId)).toContain('OPERATION_RECLAIMED');
    } finally {
      await proxy.close();
    }
  }, 300_000);

  it('con la firma de S pedida (respuesta del signer retenida): una sola tx, la del worker nuevo', async () => {
    const shard = new URL(env.base.executorShard.url);
    const proxy = await startTcpProxy({ host: shard.hostname, port: Number(shard.port) });
    try {
      proxy.setMode('hold');
      const before = await env.chain.safeNonce(wallet.safe);
      const worker = startWorkerProcess(
        await workerProcessEnv(env, { signerUrl: `https://127.0.0.1:${String(proxy.port)}` }),
      );
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      await killWhen(
        worker,
        async () => (await statusOf(env, prepared.operationId)) === 'READY' && proxy.heldBytes() > 0,
      );
      await restartAndExpectMined(prepared.operationId, before);
      expect(await chainTxs(prepared.operationId)).toHaveLength(1);
    } finally {
      proxy.release();
      await proxy.close();
    }
  }, 300_000);

  it('entre el registro write-ahead y la transmisión: el worker nuevo retransmite la MISMA tx registrada', async () => {
    const proxy = await startFaultProxy(env.base.anvil.url);
    try {
      proxy.setMode({ kind: 'timeout', methods: ['eth_sendRawTransaction'] });
      const before = await env.chain.safeNonce(wallet.safe);
      const worker = startWorkerProcess(await workerProcessEnv(env, { rpcUrl: proxy.url }));
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      await killWhen(
        worker,
        async () =>
          (await statusOf(env, prepared.operationId)) === 'SUBMITTED' &&
          proxy.requests().includes('eth_sendRawTransaction'),
      );
      const recorded = await chainTxs(prepared.operationId);
      expect(recorded).toHaveLength(1);
      await restartAndExpectMined(prepared.operationId, before);
      const after = await chainTxs(prepared.operationId);
      expect(after).toHaveLength(1);
      expect(after[0]?.tx_hash.equals(recorded[0]?.tx_hash ?? Buffer.alloc(0))).toBe(true);
    } finally {
      await proxy.close();
    }
  }, 300_000);

  it('esperando el receipt (tx en el mempool): se mina con el worker caído y el nuevo la registra MINED', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    await env.chain.setAutomine(false);
    let operationId: string;
    try {
      const worker = startWorkerProcess(await workerProcessEnv(env));
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      operationId = prepared.operationId;
      await killWhen(worker, async () => (await statusOf(env, prepared.operationId)) === 'SUBMITTED');
      await env.chain.mine(1);
    } finally {
      await env.chain.setAutomine(true);
    }
    await restartAndExpectMined(operationId, before);
  }, 300_000);

  it('reinicio ordenado (SIGTERM) con eventos pendientes en la cola: el worker nuevo los procesa una sola vez', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const first = startWorkerProcess(await workerProcessEnv(env));
    await until(() => Promise.resolve(first.output().includes('worker iniciado') ? true : undefined), 60_000).catch(
      (error: unknown) => {
        throw new Error(`el worker no arrancó: ${String(error)}\n${first.output().slice(-4000)}`);
      },
    );
    expect(await first.kill('SIGTERM')).toBe(0);
    const ops = [
      await queueOperation(env, wallet, noopCall(wallet)),
      await queueOperation(env, wallet, noopCall(wallet)),
    ];
    const worker = startWorkerProcess(await workerProcessEnv(env));
    try {
      await until(async () => {
        const statuses = await Promise.all(ops.map((o) => statusOf(env, o.operationId)));
        return statuses.every((s) => s === 'MINED') ? true : undefined;
      }, 120_000).catch(async (error: unknown) => {
        throw new Error(
          `no llegaron a MINED: ${String(error)}\n${await diagnostics(ops.map((o) => o.operationId))}\n${worker.output().slice(-6000)}`,
        );
      });
    } finally {
      expect(await worker.kill('SIGTERM')).toBe(0);
    }
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 2n);
    expect(worker.output()).toContain('worker iniciado (outbox, email y operaciones)');
  }, 300_000);
});
