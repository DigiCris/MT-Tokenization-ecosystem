// P13.TST.e [B-SM-04], [B-FIN-02]: tx fallida (el nonce de S avanzó sin nuestra tx → TX_DROPPED y re-ejecución), tx
// minada que revierte (receipt status 0: el nonce de S se consumió y el de la Safe no) y simulación que revierte (nunca
// se transmite). Las condiciones cambian entre la simulación y la inclusión con los roles reales de USDC en el fork:
// el blacklister bloquea el destino (revert determinístico → FAILED_FINAL + alerta) y el pauser pausa el token y lo
// reanuda (revert transitorio → FAILED_RETRYABLE con re-simulación → MINED).
import { randomBytes } from 'node:crypto';
import { createWalletClient, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { startFaultProxy } from '../helpers/fault-proxy.ts';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  noopCall,
  operationRow,
  queueOperation,
  sendCall,
  startOperationsEnv,
  statusOf,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { waitForReceipt } from '../helpers/fork.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let destination: Address;

const fiatToken = parseAbi([
  'function pauser() view returns (address)',
  'function blacklister() view returns (address)',
  'function pause()',
  'function unpause()',
  'function blacklist(address account)',
  'function unBlacklist(address account)',
]);

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.failedReverted });
  wallet = await activeWallet(env);
  destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 100_000_000n);
  await env.chain.whitelistSovereign(wallet.safe, env.base.snapshot.contracts.destinationWhitelist, destination, [
    wallet.userKey,
    wallet.recoveryKey,
  ]);
}, 600_000);

afterAll(async () => {
  await env.chain.setAutomine(true);
  await env.close();
});

/** Llamada de un rol de USDC impersonado, con priority fee alta (entra antes que la tx de S en el mismo bloque). */
async function asUsdcRole(
  role: 'pauser' | 'blacklister',
  fn: 'pause' | 'unpause' | 'blacklist' | 'unBlacklist',
  wait = true,
) {
  const usdc = env.base.snapshot.tokens.USDC;
  const account = await env.chain.public.readContract({ address: usdc, abi: fiatToken, functionName: role });
  await env.chain.setBalance(account, 10n ** 18n);
  await env.chain.rpc('anvil_impersonateAccount', [account]);
  try {
    const client = createWalletClient({ account, chain: base, transport: http(env.base.anvil.url) });
    const hash: Hex = await client.writeContract({
      address: usdc,
      abi: fiatToken,
      functionName: fn,
      args: fn === 'blacklist' || fn === 'unBlacklist' ? [destination] : [],
      maxPriorityFeePerGas: 50_000_000_000n,
      maxFeePerGas: 100_000_000_000n,
    });
    if (wait) await waitForReceipt(env.chain.public, hash);
  } finally {
    await env.chain.rpc('anvil_stopImpersonatingAccount', [account]);
  }
}

describe('tx fallidas y revertidas', () => {
  it('simulación que revierte (token pausado al validar): FAILED_FINAL sin transmitir nada', async () => {
    await asUsdcRole('pauser', 'pause');
    try {
      const prepared = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 1_000_000n)).catch(
        (error: unknown) => error,
      );
      // Con el token pausado ya el prepare (pre-check) lo rechaza.
      expect(prepared).toMatchObject({ code: 'GUARD_WOULD_REVERT' });
    } finally {
      await asUsdcRole('pauser', 'unpause');
    }
    // Preparada con el token activo y pausado antes de que el worker la valide: el paso 8 la frena.
    const op = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 1_000_000n));
    await asUsdcRole('pauser', 'pause');
    try {
      await env.pipeline().processWallet(wallet.walletId);
    } finally {
      await asUsdcRole('pauser', 'unpause');
    }
    expect(await operationRow(env, op.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'GUARD_WOULD_REVERT',
      s_signature: null,
    });
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', op.operationId)
      .execute();
    expect(txs).toHaveLength(0);
  });

  it('revert minado determinístico (destino bloqueado antes de la inclusión): FAILED_FINAL, gas consumido y la Safe sin usar el nonce', async () => {
    const op = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 1_000_000n));
    const safeNonce = await env.chain.safeNonce(wallet.safe);
    await env.chain.setAutomine(false);
    try {
      const running = env.pipeline({ options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, op.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      await asUsdcRole('blacklister', 'blacklist', false);
      await env.chain.mine(1);
      await running;
    } finally {
      await env.chain.setAutomine(true);
    }
    const row = await operationRow(env, op.operationId);
    expect(row).toMatchObject({ status: 'FAILED_FINAL', last_error_code: 'GUARD_WOULD_REVERT' });
    expect(row.failure_reason).toMatch(/^REVERTED:/);
    const tx = await env.base.db.app
      .selectFrom('chain_transactions')
      .selectAll()
      .where('operation_id', '=', op.operationId)
      .executeTakeFirstOrThrow();
    expect(tx).toMatchObject({ status: 'FAILED', receipt_status: 0 });
    expect(BigInt(tx.gas_used ?? '0')).toBeGreaterThan(0n);
    expect(await env.chain.safeNonce(wallet.safe)).toBe(safeNonce);
    await asUsdcRole('blacklister', 'unBlacklist');
  });

  it('revert minado transitorio (token pausado y reanudado): FAILED_RETRYABLE, re-simulación y MINED con una tx nueva', async () => {
    const op = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 1_000_000n));
    // El worker lee la cadena a través de un proxy que retiene los receipts: ve el revert recién con el token ya
    // reanudado (la re-simulación de [B-SM-04] corre sobre el estado actual).
    const proxy = await startFaultProxy(env.base.anvil.url);
    const rpc = new RpcQuorumClient({
      primaryUrl: proxy.url,
      secondaryUrl: proxy.url,
      mode: 'local-single',
      chainId: 8453,
      timeoutMs: 2_000,
      healthIntervalMs: 60_000,
      maxHeadLagBlocks: 10,
      retries: 0,
      backoffMs: 50,
      logger: env.logger,
      metrics: env.base.metrics,
    });
    await env.chain.setAutomine(false);
    try {
      const running = env.pipeline({ rpc, options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, op.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      proxy.setMode({ kind: 'timeout', methods: ['eth_getTransactionReceipt'] });
      await asUsdcRole('pauser', 'pause', false);
      await env.chain.mine(1);
      await asUsdcRole('pauser', 'unpause', false);
      await env.chain.mine(1);
      proxy.setMode({ kind: 'pass' });
      await running;
    } finally {
      await env.chain.setAutomine(true);
      await rpc.stop();
      await proxy.close();
    }
    expect(await operationRow(env, op.operationId)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      last_error_code: 'REVERTED_TRANSIENT',
    });
    await env.machine.transition({
      operationId: op.operationId,
      from: ['FAILED_RETRYABLE'],
      to: 'QUEUED',
      actor: { type: 'WORKER', id: 'retry-scheduler' },
    });
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, op.operationId)).toBe('MINED');
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select(['status', 'account_nonce'])
      .where('operation_id', '=', op.operationId)
      .orderBy('created_at')
      .execute();
    expect(txs.map((t) => t.status)).toEqual(['FAILED', 'MINED']);
    expect(BigInt(txs[1]?.account_nonce ?? '0')).toBe(BigInt(txs[0]?.account_nonce ?? '0') + 1n);
  });

  it('tx descartada: el nonce de S avanza sin nuestra tx → TX_DROPPED, re-firma con el nonce nuevo y MINED', async () => {
    const op = await queueOperation(env, wallet, noopCall(wallet));
    await env.chain.setAutomine(false);
    try {
      const running = env.pipeline({ options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, op.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      const tx = await env.base.db.app
        .selectFrom('chain_transactions')
        .select(['tx_hash', 'account_nonce'])
        .where('operation_id', '=', op.operationId)
        .executeTakeFirstOrThrow();
      // Reemplazo externo: la tx sale del mempool y el nonce de la cuenta S avanza sin ella.
      await env.chain.rpc('anvil_dropTransaction', [`0x${tx.tx_hash.toString('hex')}`]);
      await env.chain.rpc('anvil_setNonce', [wallet.executor, `0x${(BigInt(tx.account_nonce) + 1n).toString(16)}`]);
      await env.chain.mine(1);
      await running;
    } finally {
      await env.chain.setAutomine(true);
    }
    expect(await operationRow(env, op.operationId)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      last_error_code: 'TX_DROPPED',
    });
    const dropped = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('status')
      .where('operation_id', '=', op.operationId)
      .execute();
    expect(dropped.map((t) => t.status)).toEqual(['DROPPED']);
    await env.machine.transition({
      operationId: op.operationId,
      from: ['FAILED_RETRYABLE'],
      to: 'QUEUED',
      actor: { type: 'WORKER', id: 'retry-scheduler' },
    });
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, op.operationId)).toBe('MINED');
  });
});
