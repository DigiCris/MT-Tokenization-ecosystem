// P13.T11 / P13.TST.k (paso 7b de [B-Q-02], [B-FIN-03]): U+R cambian la configuración de la Safe por el camino
// soberano en el fork (retiran el Guard; en otra wallet, ponen un fallback handler). El backend no co-firma: el envío de
// la firma responde SAFE_CONFIG_MODIFIED, el worker deja la operación FAILED_FINAL, la reconciliación lo detecta aun sin
// operaciones y la wallet queda SOVEREIGN_MODIFIED con auditoría, notificación y email. El signer, por su cuenta,
// también se niega (SAFE_CONFIG_MODIFIED) ante el mismo pedido con firmas válidas.
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress, parseAbiItem, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi } from '../../src/chain/abis/index.ts';
import type { CanonicalIntent } from '../../src/operations/intent.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { waitForMessage } from '../helpers/mailpit.ts';
import {
  activeWallet,
  noopCall,
  operationRow,
  prepare,
  queueOperation,
  startOperationsEnv,
  submissionBody,
  submitSignature,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.configDrift });
}, 600_000);

afterAll(async () => {
  await env.close();
});

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const setFallbackHandler = parseAbiItem('function setFallbackHandler(address handler)');

async function walletState(walletId: string) {
  return env.base.db.app
    .selectFrom('wallets')
    .select(['status', 'config_drift', 'config_drift_at'])
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
}

async function removeGuard(wallet: ActiveWallet): Promise<void> {
  await env.chain.execSovereign(
    wallet.safe,
    { to: wallet.safe, data: encodeFunctionData({ abi: iSafeAbi, functionName: 'setGuard', args: [ZERO] }) },
    [wallet.userKey, wallet.recoveryKey],
  );
}

describe('deriva de configuración de la Safe', () => {
  it('U+R retiran el Guard: el backend no co-firma, la wallet queda SOVEREIGN_MODIFIED y el signer también se niega', async () => {
    const wallet = await activeWallet(env);
    // La ejecución soberana consume el nonce n (la primera encolada queda NONCE_CONSUMED); la segunda (n+1) llega al
    // paso 7b del worker.
    const consumed = await queueOperation(env, wallet, noopCall(wallet));
    const queued = await queueOperation(env, wallet, noopCall(wallet));
    const pending = await prepare(env, wallet, noopCall(wallet));
    await removeGuard(wallet);

    // Envío de firma: lectura con quórum → deriva → SOVEREIGN_MODIFIED y 409.
    const response = await submitSignature(wallet, pending.operationId, await submissionBody(wallet, pending));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'SAFE_CONFIG_MODIFIED',
      detail: expect.stringContaining('GUARD') as unknown,
    });
    const state = await walletState(wallet.walletId);
    expect(state.status).toBe('SOVEREIGN_MODIFIED');
    expect(state.config_drift).toEqual(['GUARD']);
    expect(state.config_drift_at).toBeInstanceOf(Date);

    // El worker no co-firma las que ya estaban encoladas.
    await env.pipeline().processWallet(wallet.walletId);
    expect(await operationRow(env, consumed.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'NONCE_CONSUMED',
    });
    expect(await operationRow(env, queued.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'SAFE_CONFIG_MODIFIED',
    });
    const txs = await env.base.db.app
      .selectFrom('chain_transactions')
      .select('id')
      .where('operation_id', '=', queued.operationId)
      .execute();
    expect(txs).toHaveLength(0);

    // Una wallet SOVEREIGN_MODIFIED no prepara operaciones nuevas.
    await expect(prepare(env, wallet, noopCall(wallet))).rejects.toMatchObject({ code: 'SAFE_CONFIG_MODIFIED' });

    // Auditoría, notificación y email al usuario (una sola vez).
    const audits = await env.base.db.app
      .selectFrom('audit_events')
      .select(['payload'])
      .where('event_type', '=', 'WALLET_SOVEREIGN_MODIFIED')
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ items: ['GUARD'] });
    const notifications = await env.base.db.app
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(notifications.map((n) => n.type)).toEqual(['SAFE_CONFIG_MODIFIED']);
    const email = await waitForMessage(wallet.onboarded.user.account.email, (m) =>
      m.subject.includes('La configuración de tu Safe cambió fuera de la plataforma'),
    );
    expect(email.text).toContain('Cambios detectados: GUARD');

    // El signer, con su propio RPC y su propia DB, tampoco co-firma el mismo pedido con firmas válidas.
    const row = await operationRow(env, queued.operationId);
    const intent = row.canonical_intent as CanonicalIntent;
    const fees = await env.base.rpc.feeData();
    const accountNonce = await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' });
    const request = {
      operationId: row.id,
      walletId: row.wallet_id,
      safe: intent.safe,
      chainId: 8453,
      operationType: intent.operationType,
      safeTx: intent.safeTx,
      ownerSignature: `0x${row.owner_signature?.toString('hex') ?? ''}`,
      ownerRole: row.owner_role,
      platformSessionToken: row.platform_session_token,
      submissionEnvelope: row.submission_envelope,
      submissionEnvelopeSignature: row.submission_envelope_signature,
      policySnapshotVersion: env.base.snapshot.version,
      execution: {
        accountNonce: String(accountNonce),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
    };
    const refused = await env.base.executorShard.client.signSafeTx(request).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SignerClientError);
    expect((refused as SignerClientError).code).toBe('SAFE_CONFIG_MODIFIED');
  });

  it('fallback handler puesto por U+R en una wallet sin operaciones: la reconciliación completa la marca', async () => {
    const wallet = await activeWallet(env);
    const handler = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await env.chain.execSovereign(
      wallet.safe,
      { to: wallet.safe, data: encodeFunctionData({ abi: [setFallbackHandler], args: [handler] }) },
      [wallet.userKey, wallet.recoveryKey],
    );
    // Sin operaciones no finales no entra en la pasada de 60 s; sí en la completa diaria.
    const active = await env.reconciler().runOnce('active');
    expect(active.discrepancies.filter((d) => d.walletId === wallet.walletId)).toEqual([]);
    expect((await walletState(wallet.walletId)).status).toBe('ACTIVE');
    const full = await env.reconciler().runOnce('full');
    expect(full.discrepancies).toContainEqual(
      expect.objectContaining({ walletId: wallet.walletId, kind: 'config', detail: { items: ['FALLBACK_HANDLER'] } }),
    );
    const state = await walletState(wallet.walletId);
    expect(state.status).toBe('SOVEREIGN_MODIFIED');
    expect(state.config_drift).toEqual(['FALLBACK_HANDLER']);
  });
});
