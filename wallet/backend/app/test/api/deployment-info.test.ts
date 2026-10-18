// P12.T08: GET /wallets/{id}/deployment devuelve lo que el frontend necesita para verificar la Safe por su cuenta (U, R,
// S, salt, factory, singleton, proxy factory, direcciones del sistema y Safe esperada) en cada etapa del onboarding; la
// Safe operativa sólo aparece en GET /wallets/me con la wallet ACTIVE. Exige sesión de cuenta, existe sólo en el
// listener de Wallet y la wallet de otro usuario es 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deploy, onboard, startOnboardingEnv, type OnboardingEnv } from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.deploymentInfo });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

describe('información de deploy', () => {
  it('evoluciona con el onboarding: claves, salt, sistema y Safe esperada; la Safe operativa recién con ACTIVE', async () => {
    const o = await onboard(env, 'user-key');
    const get = async () => {
      const response = await o.user.wallet.get(`/api/v1/wallets/${o.walletId}/deployment`);
      expect(response.statusCode).toBe(200);
      return response.json<Record<string, unknown>>();
    };
    const c = env.snapshot.contracts;
    const early = await get();
    expect(early).toEqual({
      walletId: o.walletId,
      status: 'CREATING',
      U: o.userKey.account.address,
      R: null,
      S: null,
      saltNonce: expect.stringMatching(/^\d+$/) as unknown,
      factory: c.walletFactory,
      singleton: c.safeL2Singleton,
      proxyFactory: c.safeProxyFactory,
      bootstrap: c.safeBootstrap,
      guard: c.securityGuard,
      moduleGuard: c.denyAllModuleGuard,
      timelock: c.rotationTimelock,
      policyRegistry: c.policyRegistry,
      whitelist: c.destinationWhitelist,
      swapExecutor: c.swapExecutor,
      expectedSafe: null,
      configHash: null,
      deployTxHash: null,
      failureReason: null,
    });

    // Con R y S asignadas aparece la Safe esperada; el salt no cambia (depende sólo de plataforma y wallet).
    const authorized = await onboard(env, 'authorized');
    const mid = (await authorized.user.wallet.get(`/api/v1/wallets/${authorized.walletId}/deployment`)).json<
      Record<string, unknown>
    >();
    expect(mid).toMatchObject({
      status: 'CREATING',
      U: authorized.userKey.account.address,
      R: authorized.recoveryKey.account.address,
      S: authorized.plan.executor,
      saltNonce: authorized.plan.saltNonce,
      expectedSafe: authorized.plan.expectedSafe,
    });
    expect(mid.configHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await authorized.user.wallet.get('/api/v1/wallets/me')).json()).toMatchObject({
      wallet: { status: 'CREATING', safe: null },
    });

    expect(await deploy(env, authorized)).toBe('ACTIVE');
    const done = (await authorized.user.wallet.get(`/api/v1/wallets/${authorized.walletId}/deployment`)).json<
      Record<string, unknown>
    >();
    expect(done).toMatchObject({ status: 'ACTIVE', expectedSafe: authorized.plan.expectedSafe });
    expect(done.deployTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await authorized.user.wallet.get('/api/v1/wallets/me')).json()).toMatchObject({
      wallet: { status: 'ACTIVE', safe: authorized.plan.expectedSafe },
    });
  });

  it('sin sesión de cuenta 401, en Recovery no existe y la wallet de otro usuario es 404', async () => {
    const a = await onboard(env, 'user-key');
    const b = await onboard(env, 'user-key');
    expect((await env.wallet.newClient().get(`/api/v1/wallets/${a.walletId}/deployment`)).statusCode).toBe(401);
    expect((await a.user.recovery.get(`/api/v1/wallets/${a.walletId}/deployment`)).statusCode).toBe(404);
    expect((await b.user.wallet.get(`/api/v1/wallets/${a.walletId}/deployment`)).statusCode).toBe(404);
    expect((await b.user.wallet.get(`/api/v1/wallets/${crypto.randomUUID()}/deployment`)).statusCode).toBe(404);
  });
});
