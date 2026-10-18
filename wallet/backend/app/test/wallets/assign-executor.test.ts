// P12.T03–T04 contra el fork y un shard real del signer: con R ya enviada por Recovery, POST /wallets/{id}/executor
// pide S al shard asignado (POST /v1/keys por mTLS), guarda signer_keys con la SignerKeyAttestation [B-SIG-07] y
// devuelve la Safe esperada (cálculo local == WalletFactory.predictWalletAddress) con el typed data de
// WalletCreationAuthorization que firma U. Idempotente; sin R o con el signer caído no avanza.
import { compactVerify } from 'jose';
import { getAddress, keccak256 } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { safeInitializer } from '../../src/chain/create2.ts';
import { walletSaltNonce } from '../../src/wallets/salt.ts';
import { critical, onboard, startOnboardingEnv, type OnboardingEnv } from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.walletAssignExecutor });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

describe('asignación de S y Safe esperada', () => {
  it('S del shard asignado con su atestación; Safe esperada y typed data a firmar por U', async () => {
    const o = await onboard(env, 'executor');
    const plan = o.plan;
    expect(plan.shardId).toBe('dev-1');
    // La atestación la firmó la clave de atestación del signer: {walletId, shardId, executor, chainId, issuedAt}.
    const { payload } = await compactVerify(plan.executorAttestation, env.keys.attestation.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    expect(claims).toMatchObject({ walletId: o.walletId, shardId: 'dev-1', executor: plan.executor, chainId: 8453 });

    const stored = await env.db.app
      .selectFrom('signer_keys')
      .select(['shard_id', 'status', 'attestation', 'address'])
      .where('wallet_id', '=', o.walletId)
      .execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ shard_id: 'dev-1', status: 'ACTIVE', attestation: plan.executorAttestation });
    expect(getAddress(`0x${stored[0]?.address.toString('hex')}`)).toBe(plan.executor);
    const s = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['status', 'source'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'S')
      .executeTakeFirstOrThrow();
    expect(s).toEqual({ status: 'PENDING', source: 'SIGNER_SHARD' });

    // Safe esperada: la misma que predice la factory, con el salt de la wallet; config_hash = keccak256(initializer).
    const saltNonce = walletSaltNonce(env.wallet.config.platformId, o.walletId);
    expect(plan.saltNonce).toBe(saltNonce.toString());
    const { value: predicted } = await env.rpc.readContract({
      address: env.snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'predictWalletAddress',
      args: [o.userKey.account.address, o.recoveryKey.account.address, plan.executor, saltNonce],
    });
    expect(plan.expectedSafe).toBe(predicted);
    const wallet = await env.db.app
      .selectFrom('wallets')
      .select(['expected_safe', 'config_hash', 'salt_nonce', 'factory_address', 'status', 'safe_address'])
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(wallet.status).toBe('CREATING');
    expect(wallet.safe_address).toBeNull();
    expect(getAddress(`0x${wallet.expected_safe?.toString('hex')}`)).toBe(predicted);
    expect(wallet.salt_nonce).toBe(saltNonce.toString());
    const initializer = safeInitializer(
      { userKey: o.userKey.account.address, recoveryKey: o.recoveryKey.account.address, executor: plan.executor },
      env.snapshot.contracts.safeBootstrap,
    );
    expect(`0x${wallet.config_hash?.toString('hex')}`).toBe(keccak256(initializer));
    expect(plan.typedData).toMatchObject({
      domain: {
        name: 'MTW Wallet',
        version: '1',
        chainId: 8453,
        verifyingContract: env.snapshot.contracts.walletFactory,
      },
      primaryType: 'WalletCreationAuthorization',
      message: {
        userId: o.user.account.id,
        platformId: env.wallet.config.platformId,
        walletId: o.walletId,
        userKey: o.userKey.account.address,
        recoveryKey: getAddress(o.recoveryKey.account.address),
        executor: plan.executor,
        saltNonce: saltNonce.toString(),
        expectedSafe: predicted,
      },
    });
    // La información de deploy refleja la asignación (la Safe todavía no es operativa).
    const info = await o.user.wallet.get(`/api/v1/wallets/${o.walletId}/deployment`);
    expect(info.json()).toMatchObject({
      status: 'CREATING',
      S: plan.executor,
      expectedSafe: predicted,
      deployTxHash: null,
    });
  });

  it('idempotente: repetir la asignación devuelve la misma S y la misma Safe (sin otra clave en el signer)', async () => {
    const o = await onboard(env, 'executor');
    const again = await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/executor`, {});
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ executor: o.plan.executor, expectedSafe: o.plan.expectedSafe });
    const keys = await env.db.app.selectFrom('signer_keys').select('id').where('wallet_id', '=', o.walletId).execute();
    expect(keys).toHaveLength(1);
    const health = await env.executorShard.client.health();
    expect(health.keys.active).toBeGreaterThanOrEqual(1);
  });

  it('sin R enviada no se asigna S; con el signer caído responde 503 y no guarda nada', async () => {
    const pending = await onboard(env, 'user-key');
    const noR = await critical(pending.user.wallet, pending.onboarding, `/wallets/${pending.walletId}/executor`, {});
    expect(noR.statusCode).toBe(409);

    const o = await onboard(env, 'submitted');
    await env.executorShard.stop();
    const down = await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/executor`, {});
    expect(down.statusCode).toBe(503);
    const keys = await env.db.app.selectFrom('signer_keys').select('id').where('wallet_id', '=', o.walletId).execute();
    expect(keys).toHaveLength(0);
    const wallet = await env.db.app
      .selectFrom('wallets')
      .select('expected_safe')
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(wallet.expected_safe).toBeNull();
  });
});
