// P14.T06: lecturas de P14 — saldos, whitelist y grupo de swap — y sus escrituras con IDOR de [B-AUTHZ]: otro usuario
// recibe 404 en cada recurso (wallet, pedido de whitelist, grupo), sin revelar si existe; una PlatformSession atada a
// otra wallet del mismo usuario no opera sobre esta (SCOPE_NOT_ALLOWED); cada listener expone sólo sus rutas.
import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { critical, idempotencyKey, resetRateLimits } from '../helpers/onboarding.ts';
import {
  activeWallet,
  requestWhitelist,
  sessionOf,
  startOperationsEnv,
  syncChain,
  USDC_HOLDER,
  USDT_HOLDER,
  walletPost,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let alice: ActiveWallet;
let bob: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.readEndpoints });
  alice = await activeWallet(env);
  bob = await activeWallet(env);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, alice.safe, 7_000_000n);
  await env.chain.fund(env.base.snapshot.tokens.USDT, USDT_HOLDER, alice.safe, 3_000_000n);
}, 900_000);

afterAll(async () => {
  await env.close();
});

const randomDestination = () => getAddress(`0x${randomBytes(20).toString('hex')}`);

describe('saldos', () => {
  it('USDC y USDT de la Safe con la allowance hacia el SwapExecutor, leídos con quórum; ajena → 404', async () => {
    const response = await alice.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/balances`);
    expect(response.statusCode, response.body).toBe(200);
    const view = response.json<{
      safe: string;
      chainId: number;
      blockNumber: string;
      tokens: { symbol: string; address: string; decimals: number; balance: string; allowanceToSwapExecutor: string }[];
    }>();
    expect(view).toMatchObject({ safe: alice.safe, chainId: 8453 });
    expect(view.tokens).toEqual([
      {
        symbol: 'USDC',
        address: env.base.snapshot.tokens.USDC,
        decimals: 6,
        balance: '7000000',
        allowanceToSwapExecutor: '0',
      },
      {
        symbol: 'USDT',
        address: env.base.snapshot.tokens.USDT,
        decimals: 6,
        balance: '3000000',
        allowanceToSwapExecutor: '0',
      },
    ]);
    expect(BigInt(view.blockNumber)).toBeGreaterThan(0n);
    expect((await bob.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/balances`)).statusCode).toBe(404);
    expect((await alice.onboarded.user.wallet.get(`/api/v1/wallets/${crypto.randomUUID()}/balances`)).statusCode).toBe(
      404,
    );
    // Sin sesión de cuenta: 401. En el listener de Recovery no existe.
    expect((await env.base.wallet.newClient().get(`/api/v1/wallets/${alice.walletId}/balances`)).statusCode).toBe(401);
    expect((await alice.onboarded.user.recovery.get(`/api/v1/wallets/${alice.walletId}/balances`)).statusCode).toBe(
      404,
    );
  });
});

describe('transfers (P18.T08)', () => {
  it('los transfers entrantes indexados de la Safe, por cursor; ajena → 404; sin sesión → 401; no existe en Recovery', async () => {
    await syncChain(env);
    const first = await alice.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/transfers?limit=1`);
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<{
      items: { id: string; token: string; direction: string; counterparty: string; amount: string; status: string }[];
      nextCursor: string | null;
    }>();
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(page1.items[0]?.id);
    const second = await alice.onboarded.user.wallet.get(
      `/api/v1/wallets/${alice.walletId}/transfers?limit=10&before=${page1.nextCursor ?? ''}`,
    );
    expect(second.statusCode, second.body).toBe(200);
    const items = [...page1.items, ...second.json<{ items: typeof page1.items }>().items];
    // Más recientes primero: el fondeo de USDT fue después del de USDC.
    expect(items.map((t) => [t.token, t.direction, t.counterparty, t.amount])).toEqual([
      ['USDT', 'IN', getAddress(USDT_HOLDER), '3000000'],
      ['USDC', 'IN', getAddress(USDC_HOLDER), '7000000'],
    ]);
    expect(items.every((t) => ['MINED', 'CONFIRMED', 'FINALIZED'].includes(t.status))).toBe(true);
    expect((await bob.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/transfers`)).statusCode).toBe(404);
    expect((await bob.onboarded.user.wallet.get(`/api/v1/wallets/${bob.walletId}/transfers`)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      (await alice.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/transfers?before=no-es-uuid`))
        .statusCode,
    ).toBe(400);
    expect((await env.base.wallet.newClient().get(`/api/v1/wallets/${alice.walletId}/transfers`)).statusCode).toBe(401);
    expect((await alice.onboarded.user.recovery.get(`/api/v1/wallets/${alice.walletId}/transfers`)).statusCode).toBe(
      404,
    );
  });
});

describe('whitelist', () => {
  it('A lee su whitelist (en los dos listeners); B no la ve ni opera sobre los pedidos o la wallet de A', async () => {
    await resetRateLimits(env.base.redis);
    const created = await requestWhitelist(alice, { destination: randomDestination(), label: 'Alquiler' });
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json<{ id: string }>();
    const own = await alice.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/whitelist`);
    expect(own.statusCode).toBe(200);
    expect(
      own.json<{ requests: { id: string; status: string; challengeExpiresAt: string | null }[] }>().requests,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: request.id,
          status: 'PENDING_CHALLENGE',
          challengeExpiresAt: expect.any(String) as unknown,
        }),
      ]),
    );
    expect((await alice.onboarded.user.recovery.get(`/api/v1/wallets/${alice.walletId}/whitelist`)).statusCode).toBe(
      200,
    );
    expect((await bob.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/whitelist`)).statusCode).toBe(404);
    // B con su propia sesión: el pedido y la wallet de A no existen para él.
    const confirm = await critical(
      bob.onboarded.user.wallet,
      sessionOf(bob),
      `/whitelist/requests/${request.id}/confirm`,
      { code: '12345678' },
      { idempotencyKey: idempotencyKey() },
    );
    expect(confirm.statusCode).toBe(404);
    const attempts = await env.base.db.app
      .selectFrom('security_challenges as c')
      .innerJoin('whitelist_requests as r', 'r.challenge_id', 'c.id')
      .select('c.attempts')
      .where('r.id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(attempts.attempts).toBe(0);
    for (const path of [
      `/wallets/${alice.walletId}/whitelist/requests`,
      `/wallets/${alice.walletId}/whitelist/${randomDestination()}/remove`,
      `/wallets/${alice.walletId}/send/prepare`,
      `/wallets/${alice.walletId}/swap/prepare`,
    ]) {
      const body = path.endsWith('/requests')
        ? { destination: randomDestination(), label: 'X' }
        : path.endsWith('/send/prepare')
          ? { token: 'USDC', destination: randomDestination(), amount: '1000000' }
          : path.endsWith('/swap/prepare')
            ? { tokenIn: 'USDC', amountIn: '1000000' }
            : {};
      await resetRateLimits(env.base.redis);
      const response = await walletPost(bob, path, body);
      expect(response.statusCode, path).toBe(404);
    }
  });

  it('una PlatformSession atada a otra wallet del mismo usuario no opera sobre esta (SCOPE_NOT_ALLOWED)', async () => {
    await resetRateLimits(env.base.redis);
    // Una wallet anterior FAILED de A (como un onboarding fallido): su sesión OPERATIONS es de la wallet activa.
    const old = await env.base.db.app
      .insertInto('wallets')
      .values({
        user_id: alice.onboarded.user.account.id,
        platform_id: env.base.snapshot.platformId,
        chain_id: 8453,
        status: 'FAILED',
        failure_reason: 'TEST_PREVIOUS_ONBOARDING',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const response = await walletPost(alice, `/wallets/${old.id}/send/prepare`, {
      token: 'USDC',
      destination: randomDestination(),
      amount: '1000000',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
    const read = await alice.onboarded.user.wallet.get(`/api/v1/wallets/${old.id}/whitelist`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ entries: [], requests: [] });
  });
});

describe('grupo de un swap', () => {
  it('A lee el grupo con sus operaciones; B recibe 404 al leerlo, re-cotizarlo o revocar su allowance', async () => {
    await resetRateLimits(env.base.redis);
    const prepared = await walletPost(alice, `/wallets/${alice.walletId}/swap/prepare`, {
      tokenIn: 'USDC',
      amountIn: '2000000',
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const groupId = prepared.json<{ group: { id: string } }>().group.id;
    const read = await alice.onboarded.user.wallet.get(`/api/v1/operation-groups/${groupId}`);
    expect(read.statusCode, read.body).toBe(200);
    const group = read.json<{
      status: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      nextActions: string[];
      operations: { operationType: string; groupId: string; status: string }[];
    }>();
    expect(group).toMatchObject({
      status: 'OPEN',
      tokenIn: 'USDC',
      tokenOut: 'USDT',
      amountIn: '2000000',
      nextActions: [],
    });
    expect(group.operations.map((o) => [o.operationType, o.groupId, o.status])).toEqual([
      ['SWAP_APPROVE', groupId, 'CREATED'],
      ['SWAP', groupId, 'CREATED'],
    ]);
    // Las operaciones del grupo también aparecen en el listado de la wallet con su groupId.
    const list = await alice.onboarded.user.wallet.get(`/api/v1/wallets/${alice.walletId}/operations?limit=5`);
    expect(
      list.json<{ items: { groupId: string | null }[] }>().items.filter((i) => i.groupId === groupId),
    ).toHaveLength(2);
    expect((await bob.onboarded.user.wallet.get(`/api/v1/operation-groups/${groupId}`)).statusCode).toBe(404);
    expect((await walletPost(bob, `/operation-groups/${groupId}/requote`, {})).statusCode).toBe(404);
    expect((await walletPost(bob, `/operation-groups/${groupId}/revoke-approval`, {})).statusCode).toBe(404);
    expect((await alice.onboarded.user.wallet.get(`/api/v1/operation-groups/${crypto.randomUUID()}`)).statusCode).toBe(
      404,
    );
    // Un grupo abierto no admite re-cotización ni revocación.
    expect((await walletPost(alice, `/operation-groups/${groupId}/requote`, {})).statusCode).toBe(409);
    expect((await walletPost(alice, `/operation-groups/${groupId}/revoke-approval`, {})).statusCode).toBe(409);
  });
});

describe('rutas por listener ([B-AUTHZ] 3)', () => {
  it('Wallet no expone el grupo de emergencia; Recovery no expone send, swap, saldos ni el alta de whitelist', async () => {
    const wallet = alice.onboarded.user.wallet;
    const recovery = alice.onboarded.user.recovery;
    expect((await wallet.post(`/api/v1/wallets/${alice.walletId}/emergency/noop`, {})).statusCode).toBe(404);
    expect((await wallet.post(`/api/v1/wallets/${alice.walletId}/emergency/revoke-approval`, {})).statusCode).toBe(404);
    for (const path of [
      `/api/v1/wallets/${alice.walletId}/send/prepare`,
      `/api/v1/wallets/${alice.walletId}/swap/prepare`,
      `/api/v1/wallets/${alice.walletId}/whitelist/requests`,
      `/api/v1/operations/${crypto.randomUUID()}/two-factor`,
    ]) {
      expect((await recovery.post(path, {})).statusCode, path).toBe(404);
    }
    expect(
      (await recovery.get(`/api/v1/wallets/${alice.walletId}/swap/quote?tokenIn=USDC&amountIn=1000000`)).statusCode,
    ).toBe(404);
  });
});
