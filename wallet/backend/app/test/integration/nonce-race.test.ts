// P13.TST.b / P13.T02 [B-NONCE-01/02]: N `prepare` concurrentes de la misma Safe obtienen nonces únicos y consecutivos
// (lock de la fila de la wallet, SERIALIZABLE con reintento); una CREATED que vence o se cancela libera su nonce y la
// próxima operación lo ocupa aunque haya nonces mayores tomados; Safes distintas no se bloquean entre sí.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeWallet,
  cancelOperation,
  noopCall,
  operationRow,
  prepare,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let second: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.nonceRace });
  [wallet, second] = [await activeWallet(env), await activeWallet(env)];
}, 900_000);

afterAll(async () => {
  await env.close();
});

async function nextSafeNonce(walletId: string): Promise<bigint> {
  const row = await env.base.db.app
    .selectFrom('wallets')
    .select('next_safe_nonce')
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
  return BigInt(row.next_safe_nonce);
}

describe('carrera de nonces', () => {
  it('10 prepare concurrentes: nonces únicos y consecutivos desde el nonce on-chain', async () => {
    const onchain = await env.chain.safeNonce(wallet.safe);
    const prepared = await Promise.all(Array.from({ length: 10 }, () => prepare(env, wallet, noopCall(wallet))));
    const nonces = prepared.map((p) => BigInt(p.safeTx.nonce)).sort((a, b) => (a < b ? -1 : 1));
    expect(nonces).toEqual(Array.from({ length: 10 }, (_, i) => onchain + BigInt(i)));
    expect(new Set(prepared.map((p) => p.safeTxHash)).size).toBe(10);
    expect(await nextSafeNonce(wallet.walletId)).toBe(onchain + 10n);
  });

  it('una CREATED vencida libera su nonce: la próxima operación lo ocupa aunque haya mayores tomados', async () => {
    const ops = await Promise.all([0, 1, 2].map(() => prepare(env, second, noopCall(second))));
    const sorted = [...ops].sort((a, b) => (BigInt(a.safeTx.nonce) < BigInt(b.safeTx.nonce) ? -1 : 1));
    const middle = sorted[1];
    if (!middle) throw new Error('faltan operaciones');
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', middle.operationId)
      .execute();
    const swept = await env.operations.sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(await operationRow(env, middle.operationId)).toMatchObject({
      status: 'EXPIRED',
      failure_reason: 'NOT_SIGNED_IN_TIME',
    });
    expect(await nextSafeNonce(second.walletId)).toBe(BigInt(middle.safeTx.nonce));
    const refill = await prepare(env, second, noopCall(second));
    expect(refill.safeTx.nonce).toBe(middle.safeTx.nonce);
  });

  it('cancelar una CREATED la deja CANCELLED y su nonce vuelve a estar disponible', async () => {
    const created = await prepare(env, second, noopCall(second));
    const response = await cancelOperation(second, created.operationId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ operation: { status: 'CANCELLED' }, noop: null });
    const again = await prepare(env, second, noopCall(second));
    expect(again.safeTx.nonce).toBe(created.safeTx.nonce);
  });

  it('dos Safes preparan en paralelo sin compartir nonces ni bloquearse', async () => {
    const [a, b] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => prepare(env, wallet, noopCall(wallet)))),
      Promise.all(Array.from({ length: 5 }, () => prepare(env, second, noopCall(second)))),
    ]);
    for (const batch of [a, b]) {
      const nonces = batch.map((p) => BigInt(p.safeTx.nonce)).sort((x, y) => (x < y ? -1 : 1));
      const first = nonces[0] ?? 0n;
      expect(nonces).toEqual(nonces.map((_, i) => first + BigInt(i)));
    }
    expect(new Set(a.map((p) => p.walletId))).toEqual(new Set([wallet.walletId]));
    expect(new Set(b.map((p) => p.walletId))).toEqual(new Set([second.walletId]));
  });
});
