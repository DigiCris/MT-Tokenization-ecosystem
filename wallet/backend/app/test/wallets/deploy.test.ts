// P12.T06–T07 y P12.TST contra el fork: onboarding completo por la API hasta ACTIVE. POST /wallets/{id}/deploy deja la
// wallet en DEPLOYING con su evento de outbox; el pipeline real (dispatcher → BullMQ → worker de la cola `gas-tank`)
// llama al WalletDeployer: la cuenta gas tank del shard `platform` envía WalletFactory.createWallet(U, R, S, salt), la
// verificación V9 §16 pasa y la wallet queda ACTIVE (claves y registro OPAQUE ACTIVE, S fondeada). Una Safe que un
// tercero ya desplegó con el mismo initializer se registra sin otra tx.
import { sql } from 'kysely';
import { createPublicClient, createWalletClient, decodeFunctionData, getAddress, http, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { addressToBuffer, bufferToHex } from '../../src/lib/bytes.ts';
import {
  critical,
  idempotencyKey,
  onboard,
  startOnboardingEnv,
  TOPUP_TARGET,
  until,
  type OnboardingEnv,
} from '../helpers/onboarding.ts';
import { unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { waitForReceipt } from '../helpers/fork.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.walletDeploy });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

const publicClient = () => createPublicClient({ chain: base, transport: http(env.anvil.url) });

async function walletStatus(walletId: string): Promise<string> {
  const row = await env.db.app
    .selectFrom('wallets')
    .select('status')
    .where('id', '=', walletId)
    .executeTakeFirstOrThrow();
  return row.status;
}

describe('deploy y activación de la wallet', () => {
  it('repetir el pedido de deploy no manda otra tx: misma respuesta con el mismo Idempotency-Key y estado actual sin él', async () => {
    const o = await onboard(env);
    const key = idempotencyKey();
    const path = `/wallets/${o.walletId}/deploy`;
    const first = await critical(o.user.wallet, o.onboarding, path, {}, { idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(202);
    const replay = await critical(o.user.wallet, o.onboarding, path, {}, { idempotencyKey: key });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    // Otro pedido mientras está en DEPLOYING: devuelve el estado sin otro evento de outbox.
    const again = await critical(o.user.wallet, o.onboarding, path, {}, { idempotencyKey: idempotencyKey() });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json()).toMatchObject({ status: 'DEPLOYING' });
    const events = await env.db.app
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', o.walletId)
      .where('event_type', '=', 'WALLET_DEPLOY_REQUESTED')
      .execute();
    expect(events).toHaveLength(1);
    // El evento procesado dos veces (entrega duplicada) despliega una sola vez.
    expect(await env.deployer.handle(o.walletId)).toBe('ACTIVE');
    expect(await env.deployer.handle(o.walletId)).toBe('ACTIVE');
    const deploys = await env.db.app
      .selectFrom('chain_transactions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('purpose', '=', 'DEPLOY')
      .executeTakeFirstOrThrow();
    expect(deploys.n).toBe(1);
    // Con la wallet ACTIVE el onboarding terminó: la sesión ONBOARDING ya no actúa sobre ella.
    const after = await critical(o.user.wallet, o.onboarding, path, {}, { idempotencyKey: idempotencyKey() });
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('onboarding completo: DEPLOYING → createWallet por el gas tank → VERIFYING → verificación V9 §16 → ACTIVE', async () => {
    env.startDeployWorker();
    const o = await onboard(env);
    const response = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/deploy`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(response.statusCode).toBe(202);
    // La Safe nunca se muestra operativa antes de ACTIVE.
    expect(response.json()).toMatchObject({ id: o.walletId, status: 'DEPLOYING', safe: null });
    const event = await env.db.app
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ event_type: 'WALLET_DEPLOY_REQUESTED', payload: { walletId: o.walletId } });

    await until(async () => ((await walletStatus(o.walletId)) === 'ACTIVE' ? true : undefined), 180_000);

    const safe = getAddress(o.plan.expectedSafe);
    const info = await o.user.wallet.get(`/api/v1/wallets/${o.walletId}/deployment`);
    expect(info.statusCode).toBe(200);
    const deployment = info.json<Record<string, unknown>>();
    expect(deployment).toMatchObject({
      status: 'ACTIVE',
      U: o.userKey.account.address,
      R: o.recoveryKey.account.address,
      S: o.plan.executor,
      expectedSafe: safe,
      saltNonce: o.plan.saltNonce,
      factory: env.snapshot.contracts.walletFactory,
      failureReason: null,
    });
    expect(deployment.deployTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    const me = await o.user.wallet.get('/api/v1/wallets/me');
    expect(me.json()).toMatchObject({ wallet: { id: o.walletId, status: 'ACTIVE', safe } });

    // On-chain: Safe de la factory con U, R y S; S fondeada por el gas tank con el objetivo de la policy.
    const client = publicClient();
    expect(
      await client.readContract({
        address: env.snapshot.contracts.walletFactory,
        abi: walletFactoryAbi,
        functionName: 'isWallet',
        args: [safe],
      }),
    ).toBe(true);
    const owners = await client.readContract({ address: safe, abi: iSafeAbi, functionName: 'getOwners' });
    expect(new Set(owners.map((a) => a.toLowerCase()))).toEqual(
      new Set([o.userKey.account.address, o.recoveryKey.account.address, o.plan.executor].map((a) => a.toLowerCase())),
    );
    await until(async () =>
      (await client.getBalance({ address: o.plan.executor })) === TOPUP_TARGET ? true : undefined,
    );

    // La tx de deploy lleva exactamente createWallet(U, R, S, salt) hacia la factory (el backend no aporta calldata).
    const deployTx = await env.db.app
      .selectFrom('chain_transactions')
      .select(['raw_tx', 'status', 'purpose'])
      .where('tx_hash', '=', Buffer.from((deployment.deployTxHash as string).slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    expect(deployTx).toMatchObject({ purpose: 'DEPLOY', status: 'MINED' });
    const parsed = parseTransaction(bufferToHex(deployTx.raw_tx));
    expect(parsed.to?.toLowerCase()).toBe(env.snapshot.contracts.walletFactory.toLowerCase());
    expect(decodeFunctionData({ abi: walletFactoryAbi, data: parsed.data ?? '0x' })).toEqual({
      functionName: 'createWallet',
      args: [o.userKey.account.address, o.recoveryKey.account.address, o.plan.executor, BigInt(o.plan.saltNonce)],
    });

    // Claves y registro OPAQUE ACTIVE: la Wallet se desbloquea con OPAQUE y obtiene OPERATIONS.
    const keys = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['role', 'status'])
      .where('wallet_id', '=', o.walletId)
      .where('status', '=', 'ACTIVE')
      .execute();
    expect(keys.map((k) => k.role).sort()).toEqual(['R', 'S', 'U']);
    const unlocked = await unlockWallet(o.user.wallet, o.userKey.authSecretHex);
    expect(unlocked.session).toMatchObject({ scope: 'OPERATIONS', walletId: o.walletId, safe });

    const events = await env.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('wallet_id', '=', o.walletId)
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'WALLET_CREATED',
        'WALLET_USER_KEY_REGISTERED',
        'RECOVERY_ENROLLMENT_REQUESTED',
        'RECOVERY_ENROLLMENT_KEY_REGISTERED',
        'RECOVERY_ENROLLMENT_SUBMITTED',
        'WALLET_EXECUTOR_ASSIGNED',
        'WALLET_CREATION_AUTHORIZED',
        'WALLET_DEPLOY_REQUESTED',
        'WALLET_DEPLOYED',
        'WALLET_ACTIVATED',
      ]),
    );
    // El paso siguiente del onboarding ya no existe: ONBOARDING no se emite con la wallet ACTIVE.
    const again = await o.user.wallet.post('/api/v1/platform-sessions/step-up/start', {
      scope: 'ONBOARDING',
      sessionPublicKey: o.onboarding.key.jwk,
    });
    expect(again.statusCode).toBe(409);
  });

  it('Safe ya desplegada por un tercero con el mismo initializer: se registra sin otra tx y queda ACTIVE', async () => {
    const o = await onboard(env);
    // createWallet es permissionless: cualquiera puede desplegar la misma Safe (mismos U, R, S y salt).
    const thirdParty = privateKeyToAccount(generatePrivateKey());
    await env.anvil.rpc('anvil_setBalance', [thirdParty.address, '0x16345785d8a0000']);
    const wallet = createWalletClient({ account: thirdParty, chain: base, transport: http(env.anvil.url) });
    const hash = await wallet.writeContract({
      address: env.snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'createWallet',
      args: [o.userKey.account.address, o.recoveryKey.account.address, o.plan.executor, BigInt(o.plan.saltNonce)],
    });
    const receipt = await waitForReceipt(publicClient(), hash);
    expect(receipt.status).toBe('success');
    const deployTxsBefore = await env.db.app
      .selectFrom('chain_transactions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('purpose', '=', 'DEPLOY')
      .executeTakeFirstOrThrow();

    const response = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/deploy`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(response.statusCode).toBe(202);
    await until(async () => ((await walletStatus(o.walletId)) === 'ACTIVE' ? true : undefined), 180_000);
    const row = await env.db.app
      .selectFrom('wallets')
      .select(['safe_address', 'deploy_tx_hash'])
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(row.safe_address).toEqual(addressToBuffer(o.plan.expectedSafe));
    expect(row.deploy_tx_hash).toBeNull();
    const deployTxsAfter = await env.db.app
      .selectFrom('chain_transactions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('purpose', '=', 'DEPLOY')
      .executeTakeFirstOrThrow();
    expect(deployTxsAfter.n).toBe(deployTxsBefore.n);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('wallet_id', '=', o.walletId)
      .where('event_type', '=', 'WALLET_DEPLOYED')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ deployedBy: 'existing', txHash: null });
  });
});
