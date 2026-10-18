// P13.T04 [B-Q-02..05]: el worker S de punta a punta contra el fork y el shard real del signer: firma de U por la API →
// outbox → cola wallet-operations → pipeline de 12 pasos (lease, sesión y envelope, hash, firma estricta, nonce,
// policy, whitelist y configuración, pre-check, firma de S en el signer, write-ahead y transmisión, receipt) → MINED
// → watcher → CONFIRMED → FINALIZED. Incluye un SEND real de USDC a un destino whitelisteado, varias operaciones de la
// misma Safe en orden de nonce y el reintento con backoff cuando el signer no está disponible.
import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  auditTypes,
  noopCall,
  operationRow,
  queueOperation,
  sendCall,
  settle,
  startOperationsEnv,
  startWorker,
  statusOf,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { startTcpProxy } from '../helpers/tcp-proxy.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.workerPipeline });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

describe('pipeline del worker S', () => {
  it('NoOp: QUEUED → … → MINED → CONFIRMED → FINALIZED, con la SafeTx ejecutada on-chain y todo auditado', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    expect(BigInt(prepared.safeTx.nonce)).toBe(before);
    expect(await statusOf(env, prepared.operationId)).toBe('QUEUED');
    const outbox = await env.base.db.app
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', prepared.operationId)
      .execute();
    expect(outbox).toEqual([
      { event_type: 'OPERATION_QUEUED', payload: { operationId: prepared.operationId, walletId: wallet.walletId } },
    ]);

    await env.pipeline().processWallet(wallet.walletId);
    const mined = await operationRow(env, prepared.operationId);
    expect(mined.status).toBe('MINED');
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    expect(mined.s_signature).not.toBeNull();
    expect(mined.tx_hash).not.toBeNull();
    expect(mined.block_hash).not.toBeNull();
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .selectAll()
      .where('operation_id', '=', prepared.operationId)
      .execute();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ purpose: 'EXEC', status: 'MINED', receipt_status: 1 });
    expect(getAddress(`0x${txs[0]?.from_address.toString('hex') ?? ''}`)).toBe(getAddress(wallet.executor));
    // El tx hash minado es el de la tx que firmó S.
    expect(txs[0]?.tx_hash.equals(mined.tx_hash ?? Buffer.alloc(0))).toBe(true);

    await settle(env, prepared.operationId, 'FINALIZED');
    const finalized = await operationRow(env, prepared.operationId);
    expect(finalized.confirmed_at).toBeInstanceOf(Date);
    expect(finalized.finalized_at).toBeInstanceOf(Date);
    const tx = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('status')
      .where('operation_id', '=', prepared.operationId)
      .executeTakeFirstOrThrow();
    expect(tx.status).toBe('FINALIZED');
    expect(await auditTypes(env, prepared.operationId)).toEqual([
      'OPERATION_PROPOSED',
      'OPERATION_USER_SIGNED',
      'OPERATION_SIGNATURE_RECEIVED',
      'OPERATION_QUEUED',
      'OPERATION_VALIDATING',
      'OPERATION_READY',
      'OPERATION_SUBMITTED',
      'S_SIGNATURE_ISSUED',
      'S_EXECUTION_SUBMITTED',
      'OPERATION_MINED',
      'OPERATION_CONFIRMED',
      'OPERATION_FINALIZED',
    ]);
    // La API muestra el estado, las confirmaciones y el historial completo.
    const view = await env.operations.get(wallet.actor.userId, prepared.operationId);
    expect(view).toMatchObject({ status: 'FINALIZED', confirmations: { safe: true, finalized: true } });
    expect(view.history.map((h) => h.status)).toEqual([
      'CREATED',
      'USER_SIGNED',
      'QUEUED',
      'VALIDATING',
      'READY',
      'SUBMITTED',
      'MINED',
      'CONFIRMED',
      'FINALIZED',
    ]);
  });

  it('SEND real de USDC a un destino whitelisteado: el saldo se mueve on-chain', async () => {
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    const usdc = env.base.snapshot.tokens.USDC;
    await env.chain.fund(usdc, USDC_HOLDER, wallet.safe, 50_000_000n);
    await env.chain.whitelistSovereign(wallet.safe, env.base.snapshot.contracts.destinationWhitelist, destination, [
      wallet.userKey,
      wallet.recoveryKey,
    ]);
    const safeBefore = await env.chain.tokenBalance(usdc, wallet.safe);
    const prepared = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 5_000_000n));
    expect(prepared.decoded).toEqual({ token: 'USDC', amount: '5000000', destination });
    expect(prepared.requiresTwoFactor).toBe(false);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
    expect(await env.chain.tokenBalance(usdc, destination)).toBe(5_000_000n);
    expect(await env.chain.tokenBalance(usdc, wallet.safe)).toBe(safeBefore - 5_000_000n);
  });

  it('varias operaciones de la misma Safe se ejecutan en una pasada, en orden estricto de nonce', async () => {
    const start = await env.chain.safeNonce(wallet.safe);
    const ops = [];
    for (let i = 0; i < 3; i++) ops.push(await queueOperation(env, wallet, noopCall(wallet)));
    expect(ops.map((o) => BigInt(o.safeTx.nonce))).toEqual([start, start + 1n, start + 2n]);
    await env.pipeline().processWallet(wallet.walletId);
    const rows = await Promise.all(ops.map((o) => operationRow(env, o.operationId)));
    expect(rows.map((r) => r.status)).toEqual(['MINED', 'MINED', 'MINED']);
    const blocks = rows.map((r) => BigInt(r.block_number ?? '0'));
    expect(blocks[0]).toBeLessThan(blocks[1] ?? 0n);
    expect(blocks[1]).toBeLessThan(blocks[2] ?? 0n);
    expect(await env.chain.safeNonce(wallet.safe)).toBe(start + 3n);
  });

  it('signer caído: FAILED_RETRYABLE con backoff y last_error_code; el scheduler la re-encola y termina MINED', async () => {
    const shard = new URL(env.base.executorShard.url);
    const proxy = await startTcpProxy({ host: shard.hostname, port: Number(shard.port) });
    try {
      proxy.setMode('refuse');
      const signerUrl = `https://127.0.0.1:${String(proxy.port)}`;
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      await env.pipeline({ signerUrl }).processWallet(wallet.walletId);
      const failed = await operationRow(env, prepared.operationId);
      expect(failed).toMatchObject({
        status: 'FAILED_RETRYABLE',
        last_error_code: 'SIGNER_UNAVAILABLE',
        retry_count: 1,
      });
      expect(failed.next_attempt_at).toBeInstanceOf(Date);
      expect(failed.s_signature).toBeNull();

      proxy.setMode('pass');
      const worker = startWorker(env, { pipeline: env.pipeline({ signerUrl }) });
      try {
        await until(async () => {
          await worker.schedule();
          return (await statusOf(env, prepared.operationId)) === 'MINED' ? true : undefined;
        }, 60_000);
      } finally {
        await worker.stop();
      }
      expect(await auditTypes(env, prepared.operationId)).toContain('OPERATION_FAILED_RETRYABLE');
    } finally {
      await proxy.close();
    }
  });

  it('flujo completo por la cola: el evento OPERATION_QUEUED llega al worker por BullMQ y la Safe se procesa sola', async () => {
    const worker = startWorker(env);
    try {
      const prepared = await queueOperation(env, wallet, noopCall(wallet));
      await until(async () => ((await statusOf(env, prepared.operationId)) === 'MINED' ? true : undefined), 60_000);
      const event = await env.base.db.app
        .selectFrom('outbox_events')
        .select(['dispatched_at', 'processed_at'])
        .where('aggregate_id', '=', prepared.operationId)
        .executeTakeFirstOrThrow();
      expect(event.dispatched_at).toBeInstanceOf(Date);
      await until(async () => {
        const row = await env.base.db.app
          .selectFrom('outbox_events')
          .select('processed_at')
          .where('aggregate_id', '=', prepared.operationId)
          .executeTakeFirstOrThrow();
        return row.processed_at === null ? undefined : true;
      });
    } finally {
      await worker.stop();
    }
  });
});
