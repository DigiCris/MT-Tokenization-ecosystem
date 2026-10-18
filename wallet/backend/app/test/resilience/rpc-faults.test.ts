// P13.TST.d [B-RPC-02], [B-FIN-02]: el pipeline y el watcher con quórum dual (primario = Anvil del fork, secundario =
// el mismo Anvil detrás del proxy de inyección de fallas). Un desacuerdo entre proveedores durante la validación no
// llega al signer: FAILED_RETRYABLE con RPC_DISAGREEMENT y, con los proveedores de acuerdo otra vez, la operación se
// ejecuta. Un timeout de receipts mientras la tx está en vuelo no cambia el estado (sigue SUBMITTED) hasta que hay
// consistencia; el watcher tampoco confirma sin quórum.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { startFaultProxy, type FaultProxy } from '../helpers/fault-proxy.ts';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  noopCall,
  operationRow,
  queueOperation,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let proxy: FaultProxy;
let dual: RpcQuorumClient;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rpcFaults });
  wallet = await activeWallet(env);
  proxy = await startFaultProxy(env.base.anvil.url);
  dual = new RpcQuorumClient({
    primaryUrl: env.base.anvil.url,
    secondaryUrl: proxy.url,
    mode: 'dual',
    chainId: 8453,
    timeoutMs: 2_000,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 1,
    backoffMs: 50,
    logger: env.logger,
    metrics: env.base.metrics,
  });
}, 600_000);

afterAll(async () => {
  await dual.stop();
  await proxy.close();
  await env.close();
});

async function disagreements(): Promise<number> {
  const metric = await env.base.metrics.rpcDisagreements.get();
  return metric.values.reduce((n, v) => n + v.value, 0);
}

describe('fallas de RPC', () => {
  it('desacuerdo entre proveedores: sin transición al leer el nonce; al validar, FAILED_RETRYABLE sin pedir la firma de S', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    // Las lecturas del modo dual son a `min(heads) − 1`: un bloque extra deja visible el estado actual.
    await env.chain.mine(1);
    const before = await disagreements();
    // El nonce de la Safe (eth_call) no coincide: el worker ni toma la operación.
    proxy.setMode({ kind: 'diverge', methods: ['eth_call'] });
    await env.pipeline({ rpc: dual }).processWallet(wallet.walletId);
    expect(await operationRow(env, prepared.operationId)).toMatchObject({ status: 'QUEUED', last_error_code: null });
    expect(await disagreements()).toBeGreaterThan(before);
    // La configuración de la Safe (eth_getStorageAt) no coincide al validar: reintentable y sin firma de S.
    proxy.setMode({ kind: 'diverge', methods: ['eth_getStorageAt'] });
    await env.pipeline({ rpc: dual }).processWallet(wallet.walletId);
    const failed = await operationRow(env, prepared.operationId);
    expect(failed).toMatchObject({
      status: 'FAILED_RETRYABLE',
      last_error_code: 'RPC_DISAGREEMENT',
      s_signature: null,
    });
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', prepared.operationId)
      .execute();
    expect(txs).toHaveLength(0);

    proxy.setMode({ kind: 'pass' });
    await env.machine.transition({
      operationId: prepared.operationId,
      from: ['FAILED_RETRYABLE'],
      to: 'QUEUED',
      actor: { type: 'WORKER', id: 'retry-scheduler' },
    });
    await env.pipeline({ rpc: dual }).processWallet(wallet.walletId);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
  });

  it('timeout de receipts con la tx en vuelo: sigue SUBMITTED sin transición; al volver el proveedor, MINED', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.chain.mine(1);
    proxy.setMode({ kind: 'timeout', methods: ['eth_getTransactionReceipt'] });
    const running = env.pipeline({ rpc: dual }).processWallet(wallet.walletId);
    await until(async () => ((await statusOf(env, prepared.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
    // Varios intentos fallidos de leer el receipt: el estado no cambia.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(await operationRow(env, prepared.operationId)).toMatchObject({ status: 'SUBMITTED', last_error_code: null });
    proxy.setMode({ kind: 'pass' });
    await running;
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
  });

  it('el watcher no confirma sin quórum de receipts y confirma cuando vuelve la consistencia', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    await env.chain.mine(4);
    proxy.setMode({ kind: 'timeout', methods: ['eth_getTransactionReceipt'] });
    const watcher = env.watcher(undefined, dual);
    await watcher.runOnce();
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
    proxy.setMode({ kind: 'pass' });
    await watcher.runOnce();
    expect(['CONFIRMED', 'FINALIZED']).toContain(await statusOf(env, prepared.operationId));
  });
});
