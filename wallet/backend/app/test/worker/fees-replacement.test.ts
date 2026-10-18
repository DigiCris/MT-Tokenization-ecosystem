// P13.T05 [B-NONCE-05]: tx de S con fees EIP-1559 acotados por el snapshot de policy y reemplazo por fee bump. Con el
// minado automático apagado la tx queda en el mempool: vencido el plazo del receipt, el worker pide al signer otra
// firma de la MISMA SafeTx con el MISMO nonce de cuenta y fees ≥ 112,5 %, la registra (la anterior queda ligada por
// replaced_by_id) y la transmite; al minarse, la reemplazada queda REPLACED. Un reemplazo que no entra en los topes
// no se intenta.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bumped, capped, executionFees, FeeCapExceededError } from '../../src/worker/fees.ts';
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

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.feesReplacement });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.chain.setAutomine(true);
  await env.close();
});

describe('fees de S', () => {
  it('bump ≥ 12,5 % redondeado hacia arriba y topes del snapshot', () => {
    expect(bumped(8n)).toBe(9n);
    expect(bumped(1n)).toBe(2n);
    expect(bumped(1_000_000_000n)).toBe(1_125_000_000n);
    expect(bumped(1_000_000_001n) * 8n).toBeGreaterThanOrEqual(1_000_000_001n * 9n);
    const gas = env.base.snapshot.gas;
    expect(
      capped(
        { maxFeePerGas: gas.maxFeePerGasWei * 2n, maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei * 2n },
        env.base.snapshot,
      ),
    ).toEqual({
      maxFeePerGas: gas.maxFeePerGasWei,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
    });
  });

  it('un reemplazo que supera los topes de la policy no se intenta', async () => {
    const gas = env.base.snapshot.gas;
    await expect(
      executionFees(env.base.rpc, env.base.snapshot, {
        maxFeePerGas: gas.maxFeePerGasWei,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGasWei,
      }),
    ).rejects.toBeInstanceOf(FeeCapExceededError);
    const fresh = await executionFees(env.base.rpc, env.base.snapshot);
    expect(fresh.maxFeePerGas).toBeLessThanOrEqual(gas.maxFeePerGasWei);
    expect(fresh.maxPriorityFeePerGas).toBeLessThanOrEqual(fresh.maxFeePerGas);
  });

  it('sin receipt a tiempo: reemplazo con el mismo nonce de cuenta y fees ≥ 112,5 %; se mina el reemplazo', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.chain.setAutomine(false);
    try {
      const running = env
        .pipeline({ options: { receiptTimeoutMs: 1_500, maxReplacements: 2, pollIntervalMs: 100 } })
        .processWallet(wallet.walletId);
      const txs = await until(async () => {
        const rows = await env.base.db.app
          .selectFrom('chain_transactions')
          .selectAll()
          .where('operation_id', '=', prepared.operationId)
          .orderBy('created_at')
          .execute();
        return rows.length >= 2 ? rows : undefined;
      }, 60_000);
      const [first, second] = txs;
      if (!first || !second) throw new Error('faltan tx');
      expect(second.account_nonce).toBe(first.account_nonce);
      expect(second.from_address.equals(first.from_address)).toBe(true);
      expect(BigInt(second.max_fee_per_gas) * 8n).toBeGreaterThanOrEqual(BigInt(first.max_fee_per_gas) * 9n);
      expect(BigInt(second.max_priority_fee_per_gas) * 8n).toBeGreaterThanOrEqual(
        BigInt(first.max_priority_fee_per_gas) * 9n,
      );
      expect(BigInt(second.max_fee_per_gas)).toBeLessThanOrEqual(env.base.snapshot.gas.maxFeePerGasWei);
      const linked = await env.base.db.app
        .selectFrom('chain_transactions')
        .select('replaced_by_id')
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow();
      expect(linked.replaced_by_id).toBe(second.id);
      expect((await operationRow(env, prepared.operationId)).tx_hash?.equals(second.tx_hash)).toBe(true);

      await env.chain.mine(1);
      await running;
      expect(await statusOf(env, prepared.operationId)).toBe('MINED');
      const final = await env.base.db.app
        .selectFrom('chain_transactions')
        .select(['id', 'status'])
        .where('operation_id', '=', prepared.operationId)
        .execute();
      const minedTx = final.filter((t) => t.status === 'MINED');
      expect(minedTx).toHaveLength(1);
      expect(final.filter((t) => t.status === 'REPLACED').length).toBe(final.length - 1);
      const mined = await operationRow(env, prepared.operationId);
      const minedHash = await env.base.db.app
        .selectFrom('chain_transactions')
        .select('tx_hash')
        .where('id', '=', minedTx[0]?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(mined.tx_hash?.equals(minedHash.tx_hash)).toBe(true);
    } finally {
      await env.chain.setAutomine(true);
    }
  });
});
