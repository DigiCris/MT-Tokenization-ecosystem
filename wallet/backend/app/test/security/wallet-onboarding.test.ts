// P12.SEC [B-AUTHZ]: el backend no aporta calldata arbitraria a la factory — ninguna ruta del onboarding acepta
// initializer, destino o calldata, el evento de deploy lleva sólo el id de la wallet y la tx de deploy es exactamente
// WalletFactory.createWallet(U, R, S, salt) con los valores registrados. Además: IDOR (el usuario B nunca lee ni toca la
// wallet ni el enrollment de A, ni con su propia PlatformSession) y ningún registro OPAQUE ni AuthSecret en logs o
// auditoría.
import { decodeFunctionData, getAddress, parseTransaction } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { bufferToHex } from '../../src/lib/bytes.ts';
import { captureLogger, type CapturedLogger } from '../helpers/logs.ts';
import {
  critical,
  deploy,
  idempotencyKey,
  onboard,
  signCreationAuthorization,
  startOnboardingEnv,
  stepUp,
  type OnboardingEnv,
} from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;
let logs: CapturedLogger;

beforeAll(async () => {
  logs = captureLogger('debug');
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.walletSecurity, logger: logs.logger });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

describe('seguridad del onboarding', () => {
  it('ninguna ruta acepta calldata, initializer ni destinos; la factory recibe sólo (U, R, S, salt)', async () => {
    const o = await onboard(env, 'executor');
    const injected = { initializer: '0x1234', to: env.snapshot.contracts.walletFactory, data: '0xdeadbeef' };
    expect(
      (await critical(o.user.wallet, o.onboarding, '/wallets', injected, { idempotencyKey: idempotencyKey() }))
        .statusCode,
    ).toBe(400);
    expect((await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/executor`, injected)).statusCode).toBe(
      400,
    );
    expect(
      (
        await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/deploy`, injected, {
          idempotencyKey: idempotencyKey(),
        })
      ).statusCode,
    ).toBe(400);
    const signature = await signCreationAuthorization(o.userKey.account, o.plan.typedData);
    const withExtra = await critical(
      o.user.wallet,
      o.onboarding,
      `/recovery/enrollments/${o.enrollmentId}/incorporate`,
      {
        authorization: { ...o.plan.typedData.message, initializer: '0x1234' },
        signature,
      },
    );
    expect(withExtra.statusCode).toBe(400);
    const incorporated = await critical(
      o.user.wallet,
      o.onboarding,
      `/recovery/enrollments/${o.enrollmentId}/incorporate`,
      {
        authorization: { ...o.plan.typedData.message },
        signature,
      },
    );
    expect(incorporated.statusCode, incorporated.body).toBe(200);

    expect(await deploy(env, o)).toBe('ACTIVE');
    const event = await env.db.app
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', o.walletId)
      .where('event_type', '=', 'WALLET_DEPLOY_REQUESTED')
      .executeTakeFirstOrThrow();
    expect(event.payload).toEqual({ walletId: o.walletId });
    const wallet = await env.db.app
      .selectFrom('wallets')
      .select('deploy_tx_hash')
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    const tx = await env.db.app
      .selectFrom('chain_transactions')
      .select('raw_tx')
      .where('tx_hash', '=', wallet.deploy_tx_hash ?? Buffer.alloc(32))
      .executeTakeFirstOrThrow();
    const parsed = parseTransaction(bufferToHex(tx.raw_tx));
    expect(parsed.to && getAddress(parsed.to)).toBe(env.snapshot.contracts.walletFactory);
    expect(parsed.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: walletFactoryAbi, data: parsed.data ?? '0x' })).toEqual({
      functionName: 'createWallet',
      args: [o.userKey.account.address, o.recoveryKey.account.address, o.plan.executor, BigInt(o.plan.saltNonce)],
    });
  });

  it('IDOR: B nunca lee ni modifica la wallet ni el enrollment de A, ni con su propia PlatformSession', async () => {
    const a = await onboard(env, 'submitted');
    const b = await onboard(env, 'user-key');
    const asB = (path: string, body: unknown = {}, idempotent = false) =>
      critical(b.user.wallet, b.onboarding, path, body, idempotent ? { idempotencyKey: idempotencyKey() } : {});
    const routes: [string, unknown, boolean][] = [
      [`/wallets/${a.walletId}/user-key/opaque-registration`, { registrationRequest: 'A'.repeat(64) }, false],
      [`/wallets/${a.walletId}/recovery/enrollments`, {}, true],
      [`/wallets/${a.walletId}/executor`, {}, false],
      [`/wallets/${a.walletId}/deploy`, {}, true],
      [
        `/recovery/enrollments/${a.enrollmentId}/incorporate`,
        {
          authorization: {
            userId: b.user.account.id,
            platformId: env.wallet.config.platformId,
            walletId: a.walletId,
            userKey: b.userKey.account.address,
            recoveryKey: b.recoveryKey.account.address,
            executor: b.userKey.account.address,
            saltNonce: '1',
            expectedSafe: b.recoveryKey.account.address,
            enrollmentNonce: `0x${'00'.repeat(32)}`,
          },
          signature: `0x${'11'.repeat(64)}1b`,
        },
        false,
      ],
    ];
    for (const [path, body, idempotent] of routes) {
      const response = await asB(path, body, idempotent);
      expect(response.statusCode, `${path}: ${response.body}`).toBe(404);
    }
    expect((await b.user.wallet.get(`/api/v1/wallets/${a.walletId}/deployment`)).statusCode).toBe(404);
    expect((await b.user.wallet.get(`/api/v1/recovery/enrollments/${a.enrollmentId}`)).statusCode).toBe(404);
    const enrollmentB = await stepUp(b.user.recovery, b.user.account.email, 'ENROLLMENT');
    const keyOnA = await critical(
      b.user.recovery,
      enrollmentB,
      `/recovery/enrollments/${a.enrollmentId}/enrollment-key`,
      {
        enrollmentKey: b.recoveryKey.enrollmentKey.jwk,
      },
    );
    expect(keyOnA.statusCode).toBe(404);
    // Nada de A cambió.
    const aWallet = await env.db.app
      .selectFrom('wallets')
      .select(['status', 'expected_safe'])
      .where('id', '=', a.walletId)
      .executeTakeFirstOrThrow();
    expect(aWallet).toEqual({ status: 'CREATING', expected_safe: null });
  });

  it('ni el registro OPAQUE ni el AuthSecret de U aparecen en logs ni en la auditoría', async () => {
    const o = await onboard(env, 'authorized');
    const record = await env.db.app
      .selectFrom('opaque_records')
      .select('registration_record')
      .where('wallet_id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    const canaries = [o.userKey.authSecretHex, record.registration_record.toString('base64url')];
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('wallet_id', '=', o.walletId)
      .execute();
    const auditText = JSON.stringify(audit);
    const output = logs.output();
    for (const canary of canaries) {
      expect(output).not.toContain(canary);
      expect(auditText).not.toContain(canary);
    }
    expect(audit.length).toBeGreaterThanOrEqual(6);
  });
});
