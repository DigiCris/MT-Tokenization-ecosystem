// [B-FIN-01] / ADR-018: la política `tags` de staging y producción, contra los heads `safe` y `finalized` reales del
// nodo (Anvil los publica 32 y 64 bloques detrás de `latest`). Una operación minada pasa a CONFIRMED recién cuando su
// bloque queda bajo el head `safe` y a FINALIZED bajo el head `finalized`, siempre con el hash del bloque reconfirmado;
// sin umbrales por cantidad de bloques en el backend. Lo indexado (ejecuciones de la Safe) sigue la misma regla.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChainIndexer } from '../../src/chain/indexer.ts';
import type { ConfirmationPolicy } from '../../src/chain/watcher.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
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

const TAGS: ConfirmationPolicy = { policy: 'tags', confirmationDepth: 1, finalizationDepth: 1 };

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.finalityTags });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

describe('política de finalidad tags', () => {
  it('CONFIRMED con el bloque bajo el head safe y FINALIZED bajo el head finalized', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    const minedBlock = BigInt((await operationRow(env, prepared.operationId)).block_number ?? '0');
    const watcher = env.watcher(TAGS);
    const heads = await env.base.rpc.headTags();
    expect(heads.safe).toBeLessThan(minedBlock);
    await watcher.runOnce();
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');

    await env.chain.mine(Number(minedBlock - heads.safe));
    const atSafe = await env.base.rpc.headTags();
    expect(atSafe.safe).toBeGreaterThanOrEqual(minedBlock);
    expect(atSafe.finalized).toBeLessThan(minedBlock);
    await watcher.runOnce();
    expect(await statusOf(env, prepared.operationId)).toBe('CONFIRMED');

    await env.chain.mine(40);
    expect((await env.base.rpc.headTags()).finalized).toBeGreaterThanOrEqual(minedBlock);
    await watcher.runOnce();
    expect(await statusOf(env, prepared.operationId)).toBe('FINALIZED');

    // El indexer con la misma política lleva la ejecución indexada a FINALIZED.
    const indexer = new ChainIndexer({
      db: env.base.db.app,
      rpc: env.base.rpc,
      audit: env.base.wallet.services.audit,
      snapshot: () => env.base.snapshot,
      confirmations: TAGS,
      logger: env.logger,
      metrics: env.base.metrics,
    });
    for (let i = 0; i < 20; i++) {
      const result = await indexer.runOnce();
      if (result.toBlock === null) break;
    }
    const executions = await env.base.db.app
      .selectFrom('safe_executions')
      .select(['status', 'operation_id'])
      .where('safe_address', '=', addressToBuffer(wallet.safe))
      .execute();
    expect(executions).toContainEqual({ status: 'FINALIZED', operation_id: prepared.operationId });
  });
});
