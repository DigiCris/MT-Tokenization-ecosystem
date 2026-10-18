// P13.T07 [B-FIN-03]: indexer y reconciliación contra el fork. El indexer registra las ejecuciones de la Safe desde los
// eventos de SafeL2 (las del backend ligadas a su operación y las soberanas U+R, auditadas) y los Transfer de USDC
// hacia/desde la Safe, con confirmaciones y reorg. La reconciliación compara DB ↔ cadena (nonce, ejecuciones
// indexadas, roles, whitelist, saldos) y registra cada discrepancia una sola vez (auditoría + métrica).
import { randomBytes } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChainIndexer, INDEXER_CURSOR } from '../../src/chain/indexer.ts';
import { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import {
  activeWallet,
  noopCall,
  queueOperation,
  sendCall,
  startOperationsEnv,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { startFaultProxy } from '../helpers/fault-proxy.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.reconcilerIndexer });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

async function indexToHead(): Promise<void> {
  const indexer = env.indexer();
  for (let i = 0; i < 50; i++) {
    const result = await indexer.runOnce();
    if (result.toBlock === null) return;
  }
}

async function executions() {
  return env.base.db.app
    .selectFrom('safe_executions')
    .selectAll()
    .where('safe_address', '=', addressToBuffer(wallet.safe))
    .orderBy('block_number')
    .orderBy('log_index')
    .execute();
}

async function transfers() {
  return env.base.db.app
    .selectFrom('token_transfers')
    .selectAll()
    .where('safe_address', '=', addressToBuffer(wallet.safe))
    .orderBy('block_number')
    .orderBy('log_index')
    .execute();
}

async function discrepancyAudits(walletId: string) {
  return env.base.db.app
    .selectFrom('audit_events')
    .select(['payload'])
    .where('event_type', '=', 'RECONCILIATION_DISCREPANCY')
    .where('wallet_id', '=', walletId)
    .execute();
}

describe('indexer', () => {
  it('ejecuciones de la plataforma y soberanas, y transfers de USDC entrantes y salientes, con su finalidad', async () => {
    const usdc = env.base.snapshot.tokens.USDC;
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await env.chain.fund(usdc, USDC_HOLDER, wallet.safe, 20_000_000n);
    await env.chain.whitelistSovereign(wallet.safe, env.base.snapshot.contracts.destinationWhitelist, destination, [
      wallet.userKey,
      wallet.recoveryKey,
    ]);
    const send = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 3_000_000n));
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    await indexToHead();

    const rows = await executions();
    // Whitelist soberana (U+R) + SEND + NoOp de la plataforma.
    expect(rows.map((r) => r.origin)).toEqual(['SOVEREIGN', 'PLATFORM', 'PLATFORM']);
    expect(rows.map((r) => r.safe_nonce)).toEqual(['0', '1', '2']);
    expect(rows[1]?.operation_id).toBe(send.operationId);
    expect(rows[2]?.operation_id).toBe(noop.operationId);
    expect(rows.every((r) => r.success)).toBe(true);
    const sovereignAudit = await env.base.db.app
      .selectFrom('audit_events')
      .select(['payload'])
      .where('event_type', '=', 'SAFE_SOVEREIGN_EXECUTION')
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(sovereignAudit).toHaveLength(1);
    expect(sovereignAudit[0]?.payload).toMatchObject({ nonce: '0', success: true });

    const moved = await transfers();
    expect(moved.map((t) => [t.direction, t.amount])).toEqual([
      ['IN', '20000000'],
      ['OUT', '3000000'],
    ]);
    expect(getAddress(`0x${moved[1]?.counterparty.toString('hex') ?? ''}`)).toBe(destination);

    // Finalidad: con bloques suficientes todo lo indexado llega a FINALIZED.
    await env.chain.mine(5);
    await indexToHead();
    expect((await executions()).map((r) => r.status)).toEqual(['FINALIZED', 'FINALIZED', 'FINALIZED']);
    expect((await transfers()).map((t) => t.status)).toEqual(['FINALIZED', 'FINALIZED']);
    const cursor = await env.base.db.app
      .selectFrom('chain_cursors')
      .select('block_number')
      .where('name', '=', INDEXER_CURSOR)
      .executeTakeFirstOrThrow();
    expect(BigInt(cursor.block_number)).toBeGreaterThanOrEqual((await env.chain.blockNumber()) - 1n);
  });

  it('reorg bajo el cursor: lo indexado después del punto de retroceso queda REORGED y se re-escanea', async () => {
    const txHash: Hex = await env.chain.execSovereign(wallet.safe, { to: wallet.safe, data: '0x' }, [
      wallet.userKey,
      wallet.recoveryKey,
    ]);
    await indexToHead();
    const indexed = (await executions()).find((r) => `0x${r.tx_hash.toString('hex')}` === txHash);
    expect(indexed?.status).toBe('MINED');
    const head = await env.chain.blockNumber();
    await env.chain.rpc('anvil_reorg', [Number(head - BigInt(indexed?.block_number ?? '0') + 1n), []]);
    await indexToHead();
    const after = (await executions()).find((r) => `0x${r.tx_hash.toString('hex')}` === txHash);
    expect(after?.status).toBe('REORGED');
  });
});

describe('indexer con un proveedor que limita el rango de eth_getLogs', () => {
  it('achica el rango hasta que el proveedor lo acepta y no pierde ninguna ejecución', async () => {
    await indexToHead();
    await env.chain.mine(30);
    const txHash: Hex = await env.chain.execSovereign(wallet.safe, { to: wallet.safe, data: '0x' }, [
      wallet.userKey,
      wallet.recoveryKey,
    ]);
    await env.chain.mine(30);
    const proxy = await startFaultProxy(env.base.anvil.url);
    const rpc = new RpcQuorumClient({
      primaryUrl: proxy.url,
      secondaryUrl: proxy.url,
      mode: 'local-single',
      chainId: 8453,
      timeoutMs: 10_000,
      healthIntervalMs: 60_000,
      maxHeadLagBlocks: 10,
      retries: 0,
      backoffMs: 10,
      logger: env.logger,
      metrics: env.base.metrics,
    });
    try {
      proxy.setMode({ kind: 'max-log-range', blocks: 10 });
      const limited = new ChainIndexer({
        db: env.base.db.app,
        rpc,
        audit: env.base.wallet.services.audit,
        snapshot: () => env.base.snapshot,
        confirmations: { policy: 'depth', confirmationDepth: 2, finalizationDepth: 4 },
        logger: env.logger,
        metrics: env.base.metrics,
        batchBlocks: 500,
      });
      const first = await limited.runOnce();
      expect(BigInt(first.toBlock ?? '0') - BigInt(first.fromBlock ?? '0') + 1n).toBeLessThanOrEqual(10n);
      for (let i = 0; i < 30; i++) {
        const result = await limited.runOnce();
        if (result.toBlock === null) break;
      }
    } finally {
      await rpc.stop();
      await proxy.close();
    }
    const indexed = (await executions()).find((r) => `0x${r.tx_hash.toString('hex')}` === txHash);
    expect(indexed).toMatchObject({ origin: 'SOVEREIGN', success: true });
  });
});

describe('reconciliación', () => {
  it('sin diferencias no registra nada; una divergencia de roles en la DB se audita una sola vez', async () => {
    await indexToHead();
    const clean = await env.reconciler().runOnce('full');
    expect(clean.discrepancies.filter((d) => d.walletId === wallet.walletId)).toEqual([]);

    // La U activa en la DB deja de coincidir con la de la cadena.
    const original = await env.base.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['id', 'key_address'])
      .where('wallet_id', '=', wallet.walletId)
      .where('role', '=', 'U')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    await env.base.db.app
      .updateTable('wallet_keys_metadata')
      .set({ key_address: randomBytes(20) })
      .where('id', '=', original.id)
      .execute();
    try {
      const first = await env.reconciler().runOnce('full');
      expect(first.discrepancies).toContainEqual(expect.objectContaining({ walletId: wallet.walletId, kind: 'roles' }));
      expect(await discrepancyAudits(wallet.walletId)).toHaveLength(1);
      await env.reconciler().runOnce('full');
      expect(await discrepancyAudits(wallet.walletId)).toHaveLength(1);
    } finally {
      await env.base.db.app
        .updateTable('wallet_keys_metadata')
        .set({ key_address: original.key_address })
        .where('id', '=', original.id)
        .execute();
    }
  });

  it('ejecución soberana sin indexar, destino whitelisteado sólo en la DB y saldo distinto del neto indexado', async () => {
    await indexToHead();
    const before = (await discrepancyAudits(wallet.walletId)).length;
    // Una ejecución indexada que falta, un destino ACTIVE que la cadena no tiene y un transfer inexistente.
    await env.base.db.admin.query(
      `DELETE FROM safe_executions WHERE id = (SELECT id FROM safe_executions WHERE safe_address = $1 AND status <> 'REORGED' ORDER BY block_number DESC LIMIT 1)`,
      [addressToBuffer(wallet.safe)],
    );
    await env.base.db.app
      .insertInto('whitelisted_destinations')
      .values({
        wallet_id: wallet.walletId,
        destination: randomBytes(20),
        label: 'sólo en la DB',
        status: 'ACTIVE',
        activates_at: new Date(),
        activated_at: new Date(),
      })
      .execute();
    const block = await env.chain.blockNumber();
    await env.base.db.app
      .insertInto('token_transfers')
      .values({
        chain_id: 8453,
        safe_address: addressToBuffer(wallet.safe),
        token: addressToBuffer(env.base.snapshot.tokens.USDC),
        direction: 'IN',
        counterparty: randomBytes(20),
        amount: '1',
        tx_hash: randomBytes(32),
        log_index: 0,
        block_number: (block - 1n).toString(),
        block_hash: randomBytes(32),
        status: 'FINALIZED',
      })
      .execute();
    const result = await env.reconciler().runOnce('full');
    const kinds = result.discrepancies.filter((d) => d.walletId === wallet.walletId).map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(['executions', 'whitelist', 'balance']));
    expect((await discrepancyAudits(wallet.walletId)).length).toBe(before + 3);
  });

  it('rotación pendiente en la DB que el timelock no tiene: discrepancia de rotación', async () => {
    const proposalId = randomBytes(32);
    const row = await env.base.db.app
      .insertInto('rotation_requests')
      .values({
        wallet_id: wallet.walletId,
        role: 'S',
        old_key: randomBytes(20),
        new_key: randomBytes(20),
        proposal_id: proposalId,
        executable_at: new Date(Date.now() + 48 * 3600 * 1000),
        initiated_by: 'U',
        status: 'PENDING_TIMELOCK',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const result = await env.reconciler().runOnce('full');
    expect(result.discrepancies).toContainEqual(
      expect.objectContaining({
        walletId: wallet.walletId,
        kind: 'rotation',
        detail: expect.objectContaining({ missingOnchain: [row.id] }) as unknown,
      }),
    );
  });

  it('operación MINED en la DB cuyo nonce la cadena no consumió (reorg no procesado todavía): discrepancia de nonce', async () => {
    const fresh = await activeWallet(env);
    const prepared = await queueOperation(env, fresh, noopCall(fresh));
    await env.pipeline().processWallet(fresh.walletId);
    const row = await env.base.db.app
      .selectFrom('wallet_operations')
      .select('block_number')
      .where('id', '=', prepared.operationId)
      .executeTakeFirstOrThrow();
    const head = await env.chain.blockNumber();
    await env.chain.rpc('anvil_reorg', [Number(head - BigInt(row.block_number ?? '0') + 1n), []]);
    const result = await env.reconciler().runOnce('active');
    expect(result.discrepancies).toContainEqual(expect.objectContaining({ walletId: fresh.walletId, kind: 'nonce' }));
    // Crea su propia wallet (onboarding + deploy): con el fork remoto de CI tarda más que el timeout por defecto.
  }, 300_000);
});
