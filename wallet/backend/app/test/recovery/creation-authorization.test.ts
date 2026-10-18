// P12.T05: POST /recovery/enrollments/{id}/incorporate recibe la WalletCreationAuthorization [W-01] firmada por U después
// de que la Wallet verificó la atestación de S y recalculó la Safe. El backend la acepta sólo si R es exactamente la del
// enrollment, S/salt/Safe las asignadas y la firma (EIP-712, estricta) es de U; con eso el enrollment queda CONFIRMED.
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  critical,
  idempotencyKey,
  onboard,
  signCreationAuthorization,
  startOnboardingEnv,
  type OnboardedWallet,
  type OnboardingEnv,
} from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.creationAuthorization });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

function incorporate(o: OnboardedWallet, authorization: Record<string, unknown>, signature: Hex) {
  return critical(o.user.wallet, o.onboarding, `/recovery/enrollments/${o.enrollmentId}/incorporate`, {
    authorization,
    signature,
  });
}

/** Typed data del plan con un campo cambiado (lo que firmaría una Wallet engañada). */
function altered(o: OnboardedWallet, field: string, value: unknown) {
  return { ...o.plan.typedData, message: { ...o.plan.typedData.message, [field]: value } };
}

describe('autorización de creación firmada por U', () => {
  it('con todos los campos correctos y la firma de U → CONFIRMED; repetirla es idempotente', async () => {
    const o = await onboard(env, 'executor');
    const signature = await signCreationAuthorization(o.userKey.account, o.plan.typedData);
    const authorization = { ...o.plan.typedData.message };
    const ok = await incorporate(o, authorization, signature);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'CONFIRMED', recoveryKey: o.recoveryKey.account.address });
    const row = await env.db.app
      .selectFrom('recovery_metadata')
      .select(['status', 'u_incorporation_signature', 'confirmed_at'])
      .where('enrollment_id', '=', o.enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('CONFIRMED');
    expect(`0x${row.u_incorporation_signature?.toString('hex')}`).toBe(signature.toLowerCase());
    expect((await incorporate(o, authorization, signature)).statusCode).toBe(200);
    // Ya autorizada, U no se puede reemplazar ni se puede pedir otro enrollment.
    const newEnrollment = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/recovery/enrollments`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(newEnrollment.statusCode).toBe(409);
    const newU = await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/user-key/opaque-registration`, {
      registrationRequest: 'A'.repeat(64),
    });
    expect(newU.statusCode).toBe(409);
  });

  it('R distinta de la del enrollment → rechazo, aunque U firme ese mensaje', async () => {
    const o = await onboard(env, 'executor');
    const otherR = privateKeyToAccount(generatePrivateKey()).address;
    const typed = altered(o, 'recoveryKey', otherR);
    const response = await incorporate(
      o,
      { ...typed.message },
      await signCreationAuthorization(o.userKey.account, typed),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('recoveryKey');
  });

  it('S, salt, Safe esperada o nonce del enrollment distintos de los asignados → rechazo', async () => {
    const o = await onboard(env, 'executor');
    const cases: [string, unknown][] = [
      ['executor', privateKeyToAccount(generatePrivateKey()).address],
      ['saltNonce', (BigInt(o.plan.saltNonce) + 1n).toString()],
      ['expectedSafe', privateKeyToAccount(generatePrivateKey()).address],
      ['enrollmentNonce', `0x${'cd'.repeat(32)}`],
      ['walletId', crypto.randomUUID()],
    ];
    for (const [field, value] of cases) {
      const typed = altered(o, field, value);
      const response = await incorporate(
        o,
        { ...typed.message },
        await signCreationAuthorization(o.userKey.account, typed),
      );
      expect(response.statusCode, field).toBe(409);
      expect(response.json<{ detail: string }>().detail, field).toContain(field);
    }
    const row = await env.db.app
      .selectFrom('recovery_metadata')
      .select('status')
      .where('enrollment_id', '=', o.enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('SUBMITTED');
  });

  it('firmada por otra clave (R, S o una cualquiera) o con una firma malformada → SIGNATURE_INVALID', async () => {
    const o = await onboard(env, 'executor');
    const authorization = { ...o.plan.typedData.message };
    const byR = await signCreationAuthorization(o.recoveryKey.account, o.plan.typedData);
    expect((await incorporate(o, authorization, byR)).json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    const byOther = await signCreationAuthorization(privateKeyToAccount(generatePrivateKey()), o.plan.typedData);
    expect((await incorporate(o, authorization, byOther)).statusCode).toBe(422);
    // v fuera de {27, 28} (formato eth_sign/contract de Safe) no se acepta.
    const valid = await signCreationAuthorization(o.userKey.account, o.plan.typedData);
    const badV = `${valid.slice(0, 130)}00` as Hex;
    expect((await incorporate(o, authorization, badV)).json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    // Sin la asignación de S todavía no hay nada que autorizar.
    const early = await onboard(env, 'submitted');
    const response = await incorporate(early, authorization, valid);
    expect(response.statusCode).toBe(409);
  });
});
