// P13.T08 / P13.TST.i [B-NONCE-06], [B-PSES-06]: cancelación por NoOp con el mismo nonce ganando y perdiendo la
// carrera (original encolada y original ya transmitida, con el reemplazo de la tx en vuelo de S), sesión vencida al
// enviar la firma, ejecución legítima más de 15 min después de firmar (OK) y más de 24 h (SIGNATURE_STALE) y un destino
// que deja de estar autorizado antes del paso 7.
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationWhitelistAbi } from '../../src/chain/abis/index.ts';
import { OperationService } from '../../src/operations/service.ts';
import type { PreparedOperation } from '../../src/operations/intent.ts';
import { until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  auditTypes,
  cancelOperation,
  noopCall,
  operationRow,
  prepare,
  queueOperation,
  refreshSession,
  revokeCall,
  sendCall,
  startOperationsEnv,
  statusOf,
  submissionBody,
  submitSignature,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.cancelSessionDestination });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.chain.setAutomine(true);
  await env.close();
});

async function signNoop(noop: PreparedOperation): Promise<void> {
  const response = await submitSignature(wallet, noop.operationId, await submissionBody(wallet, noop));
  if (response.statusCode !== 200) throw new Error(`firma de la NoOp: ${String(response.statusCode)} ${response.body}`);
}

describe('cancelación por NoOp', () => {
  it('original encolada: CANCEL_REQUESTED, la NoOp del mismo nonce se ejecuta y la original queda CANCELLED', async () => {
    const before = await env.chain.safeNonce(wallet.safe);
    const original = await queueOperation(env, wallet, revokeCall(env, wallet));
    const response = await cancelOperation(wallet, original.operationId);
    expect(response.statusCode, response.body).toBe(200);
    const { operation, noop } = response.json<{ operation: { status: string }; noop: PreparedOperation }>();
    expect(operation.status).toBe('CANCEL_REQUESTED');
    expect(noop).toMatchObject({
      operationType: 'NOOP_CANCEL',
      safeTx: { nonce: original.safeTx.nonce, to: wallet.safe, data: '0x' },
    });
    await signNoop(noop);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    expect(await operationRow(env, original.operationId)).toMatchObject({
      status: 'CANCELLED',
      failure_reason: 'SUPERSEDED_BY_NOOP',
    });
    expect(await env.chain.safeNonce(wallet.safe)).toBe(before + 1n);
    // La original nunca llegó a S: no tiene tx.
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', original.operationId)
      .execute();
    expect(txs).toHaveLength(0);
  });

  it('original ya transmitida (en el mempool): la NoOp reemplaza la tx en vuelo de S y gana', async () => {
    const original = await queueOperation(env, wallet, revokeCall(env, wallet));
    await env.chain.setAutomine(false);
    try {
      const running = env.pipeline({ options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, original.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      const response = await cancelOperation(wallet, original.operationId);
      expect(response.statusCode, response.body).toBe(200);
      const { noop } = response.json<{ noop: PreparedOperation }>();
      // El worker deja de esperar el receipt de la original (salió de SUBMITTED) y suelta la Safe.
      await running;
      await signNoop(noop);
      // La NoOp se procesa en segundo plano: se transmite reemplazando la tx en vuelo de S y espera el receipt.
      const processing = env.pipeline({ options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, noop.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      const noopTx = await env.base.db.app
        .selectFrom('chain_transactions')
        .selectAll()
        .where('operation_id', '=', noop.operationId)
        .executeTakeFirstOrThrow();
      const originalTx = await env.base.db.app
        .selectFrom('chain_transactions')
        .selectAll()
        .where('operation_id', '=', original.operationId)
        .executeTakeFirstOrThrow();
      expect(noopTx.account_nonce).toBe(originalTx.account_nonce);
      expect(BigInt(noopTx.max_fee_per_gas) * 8n).toBeGreaterThanOrEqual(BigInt(originalTx.max_fee_per_gas) * 9n);
      await env.chain.mine(1);
      await processing;
      expect(await operationRow(env, noop.operationId)).toMatchObject({ status: 'MINED', last_error_code: null });
      expect(await operationRow(env, original.operationId)).toMatchObject({
        status: 'CANCELLED',
        failure_reason: 'SUPERSEDED_BY_NOOP',
      });
      const replaced = await env.base.db.app
        .selectFrom('chain_transactions')
        .select('status')
        .where('id', '=', originalTx.id)
        .executeTakeFirstOrThrow();
      expect(replaced.status).toBe('REPLACED');
    } finally {
      await env.chain.setAutomine(true);
    }
  });

  it('la original se mina primero: la original queda MINED y la NoOp FAILED_FINAL ("demasiado tarde")', async () => {
    const original = await queueOperation(env, wallet, revokeCall(env, wallet));
    await env.chain.setAutomine(false);
    let noop: PreparedOperation;
    try {
      const running = env.pipeline({ options: { receiptTimeoutMs: 600_000 } }).processWallet(wallet.walletId);
      await until(async () => ((await statusOf(env, original.operationId)) === 'SUBMITTED' ? true : undefined), 60_000);
      const response = await cancelOperation(wallet, original.operationId);
      expect(response.statusCode, response.body).toBe(200);
      noop = response.json<{ noop: PreparedOperation }>().noop;
      await running;
      await signNoop(noop);
      // Se mina la tx original antes de que el worker procese la NoOp.
      await env.chain.mine(1);
    } finally {
      await env.chain.setAutomine(true);
    }
    const result = await env.watcher().runOnce();
    expect(result.cancellationsLost).toBe(1);
    expect(await statusOf(env, original.operationId)).toBe('MINED');
    expect(await operationRow(env, noop.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      failure_reason: 'CANCEL_TOO_LATE',
    });
    expect(await auditTypes(env, noop.operationId)).toContain('OPERATION_FAILED_FINAL');
  });

  it('una operación en validación responde OPERATION_BUSY; una ya minada no se cancela', async () => {
    const prepared = await queueOperation(env, wallet, revokeCall(env, wallet));
    // Un worker la tomó (QUEUED → VALIDATING) y quedó a mitad de camino.
    await env.machine.transition({
      operationId: prepared.operationId,
      from: ['QUEUED'],
      to: 'VALIDATING',
      actor: { type: 'WORKER', id: 'worker-colgado' },
      patch: { lease_version: '1' },
    });
    const busy = await cancelOperation(wallet, prepared.operationId);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: 'OPERATION_BUSY' });
    // Otro worker la retoma y la ejecuta; ya minada no se cancela.
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
    const late = await cancelOperation(wallet, prepared.operationId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'OPERATION_NOT_PENDING' });
  });
});

describe('sesión y antigüedad de la firma', () => {
  it('PlatformSession vencida al enviar la firma: 403 y la operación sigue CREATED', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const body = await submissionBody(wallet, prepared);
    await env.base.db.app
      .updateTable('platform_sessions')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', wallet.session.sessionId)
      .execute();
    const response = await submitSignature(wallet, prepared.operationId, body);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    expect(await statusOf(env, prepared.operationId)).toBe('CREATED');
    // Nueva sesión para el resto de los tests y la CREATED se cancela (libera su nonce).
    await refreshSession(wallet);
    expect((await cancelOperation(wallet, prepared.operationId)).statusCode).toBe(200);
  });

  it('ejecución legítima 16 min después de firmar: OK (la sesión se evalúa al momento del envío)', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline({ now: () => Date.now() + 16 * 60_000 }).processWallet(wallet.walletId);
    expect(await statusOf(env, prepared.operationId)).toBe('MINED');
  });

  it('más de 24 h desde el envío: SIGNATURE_STALE (worker) y el barrido vence las que esperan un nonce menor', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline({ now: () => Date.now() + 25 * 3600_000 }).processWallet(wallet.walletId);
    expect(await operationRow(env, prepared.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'SIGNATURE_STALE',
    });

    // Una bloqueada detrás de un nonce menor sin firmar: el barrido con el reloj a +25 h la vence.
    const lower = await prepare(env, wallet, noopCall(wallet));
    const blocked = await queueOperation(env, wallet, noopCall(wallet));
    expect(BigInt(blocked.safeTx.nonce)).toBe(BigInt(lower.safeTx.nonce) + 1n);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await operationRow(env, blocked.operationId)).toMatchObject({
      status: 'QUEUED',
      blocked_reason: 'WAITING_LOWER_NONCE',
    });
    const later = new OperationService({
      db: env.base.db.app,
      machine: env.machine,
      audit: env.base.wallet.services.audit,
      rpc: env.base.rpc,
      snapshot: () => env.base.snapshot,
      sovereign: env.sovereign,
      logger: env.logger,
      now: () => Date.now() + 25 * 3600_000,
    });
    const swept = await later.sweep();
    expect(swept.stale).toBeGreaterThanOrEqual(1);
    expect(await operationRow(env, blocked.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      failure_reason: 'SIGNATURE_STALE',
    });
    expect(await statusOf(env, lower.operationId)).toBe('EXPIRED');
  });
});

describe('destino no autorizado en el paso 7', () => {
  it('la baja del destino (nonce n) se ejecuta antes que el SEND (nonce n+1): el SEND termina FAILED_FINAL WHITELIST_INACTIVE', async () => {
    const usdc = env.base.snapshot.tokens.USDC;
    const whitelist = env.base.snapshot.contracts.destinationWhitelist;
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await env.chain.fund(usdc, USDC_HOLDER, wallet.safe, 10_000_000n);
    await env.chain.whitelistSovereign(wallet.safe, whitelist, destination, [wallet.userKey, wallet.recoveryKey]);
    const removal = await queueOperation(env, wallet, {
      walletId: wallet.walletId,
      operationType: 'WHITELIST_REMOVE',
      call: {
        to: whitelist,
        data: encodeFunctionData({
          abi: destinationWhitelistAbi,
          functionName: 'removeDestination',
          args: [destination],
        }),
      },
    });
    const send = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 1_000_000n));
    expect(BigInt(send.safeTx.nonce)).toBe(BigInt(removal.safeTx.nonce) + 1n);
    const balance = await env.chain.tokenBalance(usdc, destination);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, removal.operationId)).toBe('MINED');
    expect(await operationRow(env, send.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'WHITELIST_INACTIVE',
    });
    expect(await env.chain.tokenBalance(usdc, destination)).toBe(balance);
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', send.operationId)
      .execute();
    expect(txs).toHaveLength(0);
  });
});
