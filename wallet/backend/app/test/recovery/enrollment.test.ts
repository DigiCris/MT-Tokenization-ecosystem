// P12.T02 contra el fork: enrollment de la clave de recuperación R entre las dos apps. Wallet crea el enrollment
// (nonce de 32 bytes, 15 min); Recovery, con su PlatformSession ENROLLMENT, registra la Enrollment Key P-256 (una sola
// vez) y envía `RecoveryEnrollment` firmado por ella ([W-02]) con la prueba de control EIP-712 de R ([W-01]). Se
// rechazan: enrollment vencido, objeto de otro enrollment, firmas inválidas, R = U, R ya usada por otra wallet, R que
// no es una EOA, y cada ruta en el listener o con la sesión equivocados.
import { sql } from 'kysely';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  critical,
  enrollmentSubmission,
  idempotencyKey,
  newRecoveryKey,
  onboard,
  startOnboardingEnv,
  stepUp,
  type OnboardedWallet,
  type OnboardingEnv,
  type Session,
} from '../helpers/onboarding.ts';
import { newSessionKey } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.recoveryEnrollment });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

/** Wallet con U registrada y un enrollment REQUESTED; Recovery con su sesión ENROLLMENT. */
async function requested(): Promise<{
  o: OnboardedWallet;
  enrollmentId: string;
  nonce: `0x${string}`;
  enrollment: Session;
}> {
  const o = await onboard(env, 'user-key');
  const response = await critical(
    o.user.wallet,
    o.onboarding,
    `/wallets/${o.walletId}/recovery/enrollments`,
    {},
    {
      idempotencyKey: idempotencyKey(),
    },
  );
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ enrollmentId: string; nonce: `0x${string}`; expiresAt: string; status: string }>();
  expect(body.status).toBe('REQUESTED');
  expect(body.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
  const enrollment = await stepUp(o.user.recovery, o.user.account.email, 'ENROLLMENT');
  expect(enrollment.walletId).toBe(o.walletId);
  return { o, enrollmentId: body.enrollmentId, nonce: body.nonce, enrollment };
}

async function registerKey(o: OnboardedWallet, enrollment: Session, enrollmentId: string) {
  return critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/enrollment-key`, {
    enrollmentKey: o.recoveryKey.enrollmentKey.jwk,
  });
}

describe('enrollment de la clave de recuperación', () => {
  it('Enrollment Key + RecoveryEnrollment firmado + prueba de control → SUBMITTED y R PENDING', async () => {
    const { o, enrollmentId, nonce, enrollment } = await requested();
    const view = await o.user.wallet.get(`/api/v1/recovery/enrollments/${enrollmentId}`);
    expect(view.json()).toMatchObject({ status: 'REQUESTED', enrollmentKeyRegistered: false, recoveryKey: null });

    const registered = await registerKey(o, enrollment, enrollmentId);
    expect(registered.statusCode, registered.body).toBe(200);
    expect(registered.json()).toMatchObject({ enrollmentKeyRegistered: true });
    // La misma clave otra vez es idempotente; otra clave no reemplaza a la registrada.
    expect((await registerKey(o, enrollment, enrollmentId)).statusCode).toBe(200);
    const other = await critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/enrollment-key`, {
      enrollmentKey: newSessionKey().jwk,
    });
    expect(other.statusCode).toBe(409);

    const submission = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });
    const submitted = await critical(
      o.user.recovery,
      enrollment,
      `/recovery/enrollments/${enrollmentId}/submit`,
      submission,
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toMatchObject({
      status: 'SUBMITTED',
      recoveryKey: getAddress(o.recoveryKey.account.address),
      rType: 'INTERNAL',
    });
    const r = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['status', 'source', 'storage_flags'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'R')
      .executeTakeFirstOrThrow();
    expect(r).toEqual({ status: 'PENDING', source: 'INTERNAL', storage_flags: submission.storageFlags });
    // Wallet ve el mismo estado (polling del QR/link).
    expect((await o.user.wallet.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).json()).toMatchObject({
      status: 'SUBMITTED',
    });
  });

  it('una R externa (wallet conectada) requiere connectorId y queda como EXTERNAL_WALLET', async () => {
    const { o, enrollmentId, nonce, enrollment } = await requested();
    expect((await registerKey(o, enrollment, enrollmentId)).statusCode).toBe(200);
    const base = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });
    const { storageFlags: _flags, ...withoutFlags } = base;
    const missing = await critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/submit`, {
      ...withoutFlags,
      rType: 'EXTERNAL',
    });
    expect(missing.statusCode).toBe(400);
    const ok = await critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/submit`, {
      ...withoutFlags,
      rType: 'EXTERNAL',
      connectorId: 'walletconnect',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await env.db.app
      .selectFrom('recovery_metadata')
      .select(['r_type', 'connector_id'])
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ r_type: 'EXTERNAL', connector_id: 'walletconnect' });
  });

  it('rechaza firmas inválidas y un objeto que no es de este enrollment', async () => {
    const { o, enrollmentId, nonce, enrollment } = await requested();
    expect((await registerKey(o, enrollment, enrollmentId)).statusCode).toBe(200);
    const submit = (body: unknown) =>
      critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/submit`, body);
    const valid = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });

    // Firma de la Enrollment Key sobre otro contenido.
    const tampered = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: { ...o.recoveryKey, enrollmentKey: newSessionKey() },
    });
    expect((await submit({ ...valid, enrollmentKeySignature: tampered.enrollmentKeySignature })).json()).toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    // Prueba de control firmada por otra clave.
    const wrongProof = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
      proofSigner: privateKeyToAccount(generatePrivateKey()),
    });
    const proof = await submit(wrongProof);
    expect(proof.statusCode).toBe(422);
    expect(proof.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    // Nonce de otro enrollment, otro usuario o vencido.
    const otherNonce = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce: `0x${'ab'.repeat(32)}`,
      recovery: o.recoveryKey,
    });
    expect((await submit(otherNonce)).statusCode).toBe(409);
    const otherUser = await enrollmentSubmission(env, {
      userId: crypto.randomUUID(),
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });
    expect((await submit(otherUser)).statusCode).toBe(409);
    const stale = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
      issuedAt: new Date(Date.now() - 40 * 60_000),
      expiresAt: new Date(Date.now() - 10 * 60_000),
    });
    expect((await submit(stale)).statusCode).toBe(409);
    // Nada de lo anterior dejó R registrada.
    expect((await submit(valid)).statusCode).toBe(200);
  });

  it('R no puede ser U, ni una clave de otra wallet, ni un contrato', async () => {
    // R = U de la misma wallet.
    const a = await requested();
    expect((await registerKey(a.o, a.enrollment, a.enrollmentId)).statusCode).toBe(200);
    const sameAsU = await enrollmentSubmission(env, {
      userId: a.o.user.account.id,
      enrollmentId: a.enrollmentId,
      nonce: a.nonce,
      recovery: { account: a.o.userKey.account, enrollmentKey: a.o.recoveryKey.enrollmentKey },
    });
    const rejectedU = await critical(
      a.o.user.recovery,
      a.enrollment,
      `/recovery/enrollments/${a.enrollmentId}/submit`,
      sameAsU,
    );
    expect(rejectedU.statusCode).toBe(422);
    expect(rejectedU.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });

    // R ya enviada por otra wallet.
    const firstR = await enrollmentSubmission(env, {
      userId: a.o.user.account.id,
      enrollmentId: a.enrollmentId,
      nonce: a.nonce,
      recovery: a.o.recoveryKey,
    });
    expect(
      (await critical(a.o.user.recovery, a.enrollment, `/recovery/enrollments/${a.enrollmentId}/submit`, firstR))
        .statusCode,
    ).toBe(200);
    const b = await requested();
    expect((await registerKey(b.o, b.enrollment, b.enrollmentId)).statusCode).toBe(200);
    const reused = await enrollmentSubmission(env, {
      userId: b.o.user.account.id,
      enrollmentId: b.enrollmentId,
      nonce: b.nonce,
      recovery: { account: a.o.recoveryKey.account, enrollmentKey: b.o.recoveryKey.enrollmentKey },
    });
    const rejectedReuse = await critical(
      b.o.user.recovery,
      b.enrollment,
      `/recovery/enrollments/${b.enrollmentId}/submit`,
      reused,
    );
    expect(rejectedReuse.statusCode).toBe(422);
    expect(rejectedReuse.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });

    // R con código (no EOA): una cuenta a la que el fork le pone bytecode.
    const contractR = newRecoveryKey();
    await env.anvil.rpc('anvil_setCode', [contractR.account.address, '0x6080604052']);
    const asContract = await enrollmentSubmission(env, {
      userId: b.o.user.account.id,
      enrollmentId: b.enrollmentId,
      nonce: b.nonce,
      recovery: { account: contractR.account, enrollmentKey: b.o.recoveryKey.enrollmentKey },
    });
    const rejectedContract = await critical(
      b.o.user.recovery,
      b.enrollment,
      `/recovery/enrollments/${b.enrollmentId}/submit`,
      asContract,
    );
    expect(rejectedContract.statusCode).toBe(422);
    expect(rejectedContract.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });

    // Una cuenta con un designador EIP-7702 sigue siendo una EOA: se acepta.
    const delegated = newRecoveryKey();
    await env.anvil.rpc('anvil_setCode', [delegated.account.address, `0xef0100${'11'.repeat(20)}`]);
    const asDelegated = await enrollmentSubmission(env, {
      userId: b.o.user.account.id,
      enrollmentId: b.enrollmentId,
      nonce: b.nonce,
      recovery: { account: delegated.account, enrollmentKey: b.o.recoveryKey.enrollmentKey },
    });
    const accepted = await critical(
      b.o.user.recovery,
      b.enrollment,
      `/recovery/enrollments/${b.enrollmentId}/submit`,
      asDelegated,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('un enrollment vencido no acepta clave ni envío', async () => {
    const { o, enrollmentId, nonce, enrollment } = await requested();
    await env.db.app
      .updateTable('recovery_metadata')
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    const key = await registerKey(o, enrollment, enrollmentId);
    expect(key.statusCode).toBe(409);
    expect(key.json()).toMatchObject({ code: 'ENROLLMENT_EXPIRED' });
    expect((await o.user.wallet.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).json()).toMatchObject({
      status: 'EXPIRED',
    });
    const submission = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });
    const submitted = await critical(
      o.user.recovery,
      enrollment,
      `/recovery/enrollments/${enrollmentId}/submit`,
      submission,
    );
    expect(submitted.json()).toMatchObject({ code: 'ENROLLMENT_EXPIRED' });
    // Un enrollment nuevo reemplaza al vencido.
    const fresh = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/recovery/enrollments`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(fresh.statusCode).toBe(201);
  });

  it('la Wallet rechaza la R enviada (P17.MAN, N10): REJECTED con el motivo, sin incorporar ni reenviar; el pedido nuevo sigue', async () => {
    const { o, enrollmentId, nonce, enrollment } = await requested();
    expect((await registerKey(o, enrollment, enrollmentId)).statusCode).toBe(200);
    const submission = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId,
      nonce,
      recovery: o.recoveryKey,
    });
    const submit = () =>
      critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/submit`, submission);
    expect((await submit()).statusCode).toBe(200);

    // El enlace de regreso no lo armó la app Recovery del usuario: la Wallet aborta y lo informa.
    const rejected = await critical(o.user.wallet, o.onboarding, `/recovery/enrollments/${enrollmentId}/reject`, {
      reason: 'RETURN_LINK_UNVERIFIED',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_UNVERIFIED',
      recoveryKey: getAddress(o.recoveryKey.account.address),
    });
    // La sesión ENROLLMENT de Recovery no lo rechaza (ni existe la ruta en su listener).
    expect(
      (
        await critical(o.user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/reject`, {
          reason: 'RETURN_LINK_UNVERIFIED',
        })
      ).statusCode,
    ).toBe(404);
    // R quedó revocada: el mismo envío ya no entra y la Wallet no puede pedir S para esa R.
    expect((await submit()).statusCode).toBe(409);
    const r = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select('status')
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'R')
      .executeTakeFirstOrThrow();
    expect(r.status).toBe('REVOKED');
    expect((await critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/executor`, {})).statusCode).toBe(409);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('event_type', '=', 'RECOVERY_ENROLLMENT_REJECTED')
      .where('target_id', '=', enrollmentId)
      .execute();
    expect(audit.map((a) => a.payload)).toMatchObject([
      { reason: 'RETURN_LINK_UNVERIFIED', previousStatus: 'SUBMITTED' },
    ]);

    // Un pedido nuevo puede registrar otra R (también la misma, que ya no está viva en ningún lado).
    const fresh = await critical(
      o.user.wallet,
      o.onboarding,
      `/wallets/${o.walletId}/recovery/enrollments`,
      {},
      { idempotencyKey: idempotencyKey() },
    );
    expect(fresh.statusCode).toBe(201);
    const next = fresh.json<{ enrollmentId: string; nonce: `0x${string}` }>();
    const nextSession = await stepUp(o.user.recovery, o.user.account.email, 'ENROLLMENT');
    expect(
      (
        await critical(o.user.recovery, nextSession, `/recovery/enrollments/${next.enrollmentId}/enrollment-key`, {
          enrollmentKey: o.recoveryKey.enrollmentKey.jwk,
        })
      ).statusCode,
    ).toBe(200);
    const again = await enrollmentSubmission(env, {
      userId: o.user.account.id,
      enrollmentId: next.enrollmentId,
      nonce: next.nonce,
      recovery: o.recoveryKey,
    });
    const resubmitted = await critical(
      o.user.recovery,
      nextSession,
      `/recovery/enrollments/${next.enrollmentId}/submit`,
      again,
    );
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
  });

  it('cada ruta sólo en su listener y con su sesión; enrollments de otro usuario son 404', async () => {
    const { o, enrollmentId, enrollment } = await requested();
    // El envío de R y la Enrollment Key no existen en Wallet; crear e incorporar no existen en Recovery.
    expect(
      (
        await critical(o.user.wallet, o.onboarding, `/recovery/enrollments/${enrollmentId}/enrollment-key`, {
          enrollmentKey: o.recoveryKey.enrollmentKey.jwk,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await critical(
          o.user.recovery,
          enrollment,
          `/wallets/${o.walletId}/recovery/enrollments`,
          {},
          {
            idempotencyKey: idempotencyKey(),
          },
        )
      ).statusCode,
    ).toBe(404);
    // La PlatformSession ONBOARDING de Wallet no sirve en Recovery (otra sesión de cuenta y otro scope).
    const crossed = await critical(
      o.user.recovery,
      o.onboarding,
      `/recovery/enrollments/${enrollmentId}/enrollment-key`,
      {
        enrollmentKey: o.recoveryKey.enrollmentKey.jwk,
      },
    );
    expect(crossed.statusCode).toBe(403);
    // Y la sesión ENROLLMENT de Recovery no crea enrollments en Wallet.
    const crossedBack = await critical(
      o.user.wallet,
      enrollment,
      `/wallets/${o.walletId}/recovery/enrollments`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(crossedBack.statusCode).toBe(403);
    // Otro usuario no ve ni toca el enrollment.
    const intruder = await requested();
    expect((await intruder.o.user.wallet.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).statusCode).toBe(404);
    const foreign = await critical(
      intruder.o.user.recovery,
      intruder.enrollment,
      `/recovery/enrollments/${enrollmentId}/enrollment-key`,
      {
        enrollmentKey: intruder.o.recoveryKey.enrollmentKey.jwk,
      },
    );
    expect(foreign.statusCode).toBe(404);
  });
});
