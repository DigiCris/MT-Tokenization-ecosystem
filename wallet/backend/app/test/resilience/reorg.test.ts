// P13.T06 / P13.TST.f [B-FIN-01/02/04]: reorgs reales con `anvil_reorg` sobre el fork. Una tx de S que la cadena
// canónica descarta → la operación pasa a REORGED (alerta REORG_DETECTED), vuelve a QUEUED y el worker re-ejecuta la
// MISMA SafeTx hasta FINALIZED; si la misma tx se re-incluye en otro bloque → REORGED → MINED con el bloque nuevo (sin
// re-ejecutar). En ningún caso hay doble ejecución: el nonce de la Safe avanza una sola vez.
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { FinalityWatcher } from '../../src/chain/watcher.ts';
import {
  activeWallet,
  auditTypes,
  noopCall,
  operationRow,
  queueOperation,
  settle,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.reorg });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

describe('reorgs', () => {
  it('tx descartada por el reorg: CONFIRMED → REORGED → QUEUED → re-ejecución de la misma SafeTx → FINALIZED', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    const watcher = env.watcher();
    await settle(env, prepared.operationId, 'CONFIRMED', watcher);
    const mined = await operationRow(env, prepared.operationId);
    const minedBlock = BigInt(mined.block_number ?? '0');
    const head = await env.chain.blockNumber();

    // Reorg que reemplaza desde el bloque de la operación (la tx de S no entra en la cadena nueva).
    await env.chain.rpc('anvil_reorg', [Number(head - minedBlock + 1n), []]);
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before);
    // En la misma pasada: detecta el reorg (REORGED + alerta) y, como la tx no está ni minada ni en el mempool, la
    // vuelve a encolar.
    const result = await watcher.runOnce();
    expect(result).toMatchObject({ reorged: 1, requeued: 1 });
    expect(await statusOf(env, prepared.operationId)).toBe('QUEUED');
    const outbox = await env.base.db.app
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', prepared.operationId)
      .execute();
    expect(outbox.map((o) => o.event_type)).toEqual(['OPERATION_QUEUED', 'OPERATION_QUEUED']);

    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    await settle(env, prepared.operationId, 'FINALIZED', watcher);
    const types = await auditTypes(env, prepared.operationId);
    expect(types).toContain('REORG_DETECTED');
    expect(types.filter((t) => t === 'OPERATION_MINED')).toHaveLength(2);
    expect(types.at(-1)).toBe('OPERATION_FINALIZED');
    // La SafeTx re-ejecutada es la misma (mismo hash).
    expect((await operationRow(env, prepared.operationId)).safe_tx_hash.equals(mined.safe_tx_hash)).toBe(true);
  });

  it('la misma tx re-incluida en otro bloque: REORGED → MINED con el bloque nuevo, sin re-ejecutar', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    const mined = await operationRow(env, prepared.operationId);
    const tx = await env.base.db.app
      .selectFrom('chain_transactions')
      .select(['raw_tx', 'tx_hash'])
      .where('operation_id', '=', prepared.operationId)
      .executeTakeFirstOrThrow();
    const raw: Hex = `0x${tx.raw_tx.toString('hex')}`;
    const head = await env.chain.blockNumber();
    await env.chain.rpc('anvil_reorg', [Number(head - BigInt(mined.block_number ?? '0') + 1n), [[raw, 0]]]);

    const watcher = env.watcher();
    expect(await watcher.runOnce()).toMatchObject({ reorged: 1, remined: 1, requeued: 0 });
    const remined = await operationRow(env, prepared.operationId);
    expect(remined.status).toBe('MINED');
    expect(remined.block_hash?.equals(mined.block_hash ?? Buffer.alloc(0))).toBe(false);
    expect(remined.tx_hash?.equals(tx.tx_hash)).toBe(true);
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    await settle(env, prepared.operationId, 'FINALIZED', watcher);
  });

  it('desacuerdo o caída del RPC: el watcher no transiciona nada (se reintenta en la próxima pasada)', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    // RPC caído: ninguna lectura con quórum → la operación sigue MINED.
    const down = new RpcQuorumClient({
      primaryUrl: 'http://127.0.0.1:9',
      secondaryUrl: 'http://127.0.0.1:9',
      mode: 'local-single',
      chainId: 8453,
      timeoutMs: 500,
      healthIntervalMs: 60_000,
      maxHeadLagBlocks: 10,
      retries: 0,
      backoffMs: 10,
      logger: env.logger,
      metrics: env.base.metrics,
    });
    const blind = new FinalityWatcher({
      db: env.base.db.app,
      machine: env.machine,
      audit: env.base.wallet.services.audit,
      rpc: down,
      confirmations: { policy: 'depth', confirmationDepth: 1, finalizationDepth: 1 },
      logger: env.logger,
      metrics: env.base.metrics,
    });
    await env.chain.mine(5);
    const result = await blind.runOnce();
    expect(result).toEqual({ confirmed: 0, finalized: 0, reorged: 0, remined: 0, requeued: 0, cancellationsLost: 0 });
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
  });
});
