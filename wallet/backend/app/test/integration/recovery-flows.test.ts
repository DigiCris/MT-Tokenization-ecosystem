// P15.T04 / P15.T05 / P15.TST.c: los dos flujos de recovery de V9 §14 completos en el fork (con el reloj de la cadena
// adelantado 48 h).
//
// "Perdí U / Password U": step-up U_REPLACEMENT en Wallet → U′ generada en el cliente → registro OPAQUE de U′
// (PENDING, versión 2) + KeyAcceptance → borrador de rotación (email y notificación "recuperación iniciada") → R propone
// desde Recovery → 48 h → R ejecuta → U′ activa on-chain, su registro OPAQUE ACTIVE y el viejo RETIRED: la Password U′
// desbloquea la wallet (OPERATIONS) y la vieja ya no; U′ firma operaciones.
//
// "Perdí R": Wallet (OPERATIONS) crea el enrollment de reemplazo → Recovery (ENROLLMENT) registra la Enrollment Key y
// envía R′ con su prueba de control y su KeyAcceptance → U propone → 48 h → U ejecuta → R′ activa on-chain, su
// enrollment CONFIRMED y el anterior RETIRED; R′ firma en Recovery.
import { randomBytes } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { securityGuardAbi } from '../../src/chain/abis/index.ts';
import { platformTypedData } from '../../src/chain/eip712.ts';
import {
  critical,
  enrollmentSubmission,
  idempotencyKey,
  KDF_PARAMS,
  newRecoveryKey,
  newUserKey,
  opaqueRecord,
  resetRateLimits,
  stepUp,
  type Session,
  type UserKeyMaterial,
} from '../helpers/onboarding.ts';
import {
  activeWallet,
  actorFor,
  expireCreated,
  nextEmail,
  noopCall,
  queueOperation,
  startOperationsEnv,
  statusOf,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepare,
  propose,
  recoveryPost,
  recoverySession,
  rotationRow,
  signAndExecute,
  syncRotations,
  warpTimelock,
} from '../helpers/rotations.ts';

let env: OperationsEnv;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.recoveryFlows });
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
});

/** KeyAcceptance [W-01] firmada por la clave nueva. */
async function keyAcceptance(
  signer: { signTypedData: UserKeyMaterial['account']['signTypedData']; address: Hex },
  walletId: string,
  role: 1 | 2,
  nonce: Hex = `0x${randomBytes(32).toString('hex')}`,
) {
  const typed = platformTypedData(8453, env.base.snapshot.contracts.walletFactory, 'KeyAcceptance', {
    walletId,
    role,
    newKey: getAddress(signer.address),
    nonce,
  });
  return { nonce, signature: await signer.signTypedData(typed) };
}

async function onchainRoles(wallet: ActiveWallet) {
  return env.chain.public.readContract({
    address: env.base.snapshot.contracts.securityGuard,
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [wallet.safe],
  });
}

describe('perdí U / Password U', { timeout: 600_000 }, () => {
  let wallet: ActiveWallet;
  let replacement: UserKeyMaterial;
  let uSession: Session;

  beforeAll(async () => {
    wallet = await activeWallet(env);
    replacement = newUserKey();
  }, 600_000);

  it('U_REPLACEMENT: registra U′ (OPAQUE PENDING v2 + KeyAcceptance) → borrador; rechazos de material inválido', async () => {
    const user = wallet.onboarded.user;
    uSession = await stepUp(user.wallet, user.account.email, 'U_REPLACEMENT');
    expect(uSession.walletId).toBe(wallet.walletId);
    const registrationRecord = await opaqueRecord(user.wallet, uSession, wallet.walletId, replacement.authSecretHex);
    const body = {
      userKey: replacement.account.address,
      kdfParams: KDF_PARAMS,
      storageFlags: { drive: false, file: true, qr: true, words: true },
      registrationRecord,
      keyAcceptance: await keyAcceptance(replacement.account, wallet.walletId, 1),
    };
    const post = (b: unknown, session: Session = uSession) =>
      critical(user.wallet, session, '/recovery/u-replacement', b, { idempotencyKey: idempotencyKey() });

    // KeyAcceptance de otra clave, de otro rol o U′ = U vigente: rechazos sin efectos.
    const forged = await post({ ...body, keyAcceptance: await keyAcceptance(wallet.userKey, wallet.walletId, 1) });
    expect(forged.statusCode).toBe(422);
    expect(forged.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    const wrongRole = await post({
      ...body,
      keyAcceptance: await keyAcceptance(replacement.account, wallet.walletId, 2),
    });
    expect(wrongRole.statusCode).toBe(422);
    const same = await post({
      ...body,
      userKey: wallet.userKey.address,
      keyAcceptance: await keyAcceptance(wallet.userKey, wallet.walletId, 1),
    });
    expect(same.statusCode).toBe(422);
    expect(same.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });
    // La sesión OPERATIONS (U desbloqueada) no sirve: el scope es U_REPLACEMENT.
    const withOperations = await post(body, {
      token: wallet.session.token,
      sessionId: wallet.session.sessionId,
      key: wallet.session.key,
      walletId: wallet.walletId,
    });
    expect(withOperations.statusCode).toBe(403);

    const response = await post(body);
    expect(response.statusCode, response.body).toBe(201);
    const draft = response.json<{ rotationId: string; keyVersion: number; status: string; userKey: string }>();
    expect(draft).toMatchObject({ status: 'DRAFT', keyVersion: 2, userKey: replacement.account.address });
    const records = await env.base.db.app
      .selectFrom('opaque_records')
      .select(['key_version', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .orderBy('key_version')
      .execute();
    expect(records).toEqual([
      { key_version: 1, status: 'ACTIVE' },
      { key_version: 2, status: 'PENDING' },
    ]);
    const row = await rotationRow(env, draft.rotationId);
    expect(row).toMatchObject({ role: 'U', status: 'DRAFT', initiated_by: 'R' });
    // La U vigente sigue desbloqueando la wallet hasta que la rotación se ejecute on-chain.
    await unlockWallet(user.wallet, wallet.onboarded.userKey.authSecretHex);
    const email = await nextEmail(user.account.email, 'Se inició un proceso de recuperación');
    expect(email.text).toContain('reemplazo de tu clave de usuario (U)');
    const notifications = await env.base.db.app
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('wallet_id', '=', wallet.walletId)
      .where('type', '=', 'RECOVERY_STARTED')
      .execute();
    expect(notifications).toHaveLength(1);
  });

  it('R propone U → U′ desde Recovery → 48 h → R ejecuta → U′ activa: la Password U′ desbloquea y la vieja no', async () => {
    const user = wallet.onboarded.user;
    const session = await recoverySession(wallet);
    await resetRateLimits(env.base.redis);
    const { rotation, operation } = await propose(wallet, { role: 'R', session }, 'U');
    expect(rotation).toMatchObject({
      role: 'U',
      newKey: replacement.account.address,
      oldKey: wallet.userKey.address,
      initiatedBy: 'R',
    });
    // El borrador del flujo U_REPLACEMENT es la misma rotación.
    const draft = await env.base.db.app
      .selectFrom('rotation_requests')
      .select('id')
      .where('wallet_id', '=', wallet.walletId)
      .where('role', '=', 'U')
      .executeTakeFirstOrThrow();
    expect(draft.id).toBe(rotation.id);
    await signAndExecute(env, wallet, operation, { role: 'R', session });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('PENDING_TIMELOCK');

    await warpTimelock(env);
    await env.rotationSync().runOnce();
    const execution = await executePrepare(wallet, { role: 'R', session }, rotation.id);
    await signAndExecute(env, wallet, execution.operation, { role: 'R', session });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('EXECUTED');
    expect(getAddress((await onchainRoles(wallet)).userKey)).toBe(replacement.account.address);

    const records = await env.base.db.app
      .selectFrom('opaque_records')
      .select(['key_version', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .orderBy('key_version')
      .execute();
    expect(records).toEqual([
      { key_version: 1, status: 'RETIRED' },
      { key_version: 2, status: 'ACTIVE' },
    ]);
    const keys = await env.base.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['key_address', 'key_version', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .where('role', '=', 'U')
      .orderBy('key_version')
      .execute();
    expect(keys.map((k) => [k.key_version, k.status])).toEqual([
      [1, 'ROTATED_OUT'],
      [2, 'ACTIVE'],
    ]);

    // La Password U vieja ya no abre el registro; la de U′ sí, y U′ firma operaciones.
    await expect(unlockWallet(user.wallet, wallet.onboarded.userKey.authSecretHex)).rejects.toThrow();
    const unlocked = await unlockWallet(user.wallet, replacement.authSecretHex);
    wallet.session = unlocked;
    wallet.actor = actorFor(user.account.id, unlocked);
    wallet.userKey = replacement.account;
    await expireCreated(env, wallet);
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    const email = await nextEmail(user.account.email, 'Rotación de clave ejecutada');
    expect(email.text).toContain('clave de usuario (U)');
  });
});

describe('perdí R', { timeout: 600_000 }, () => {
  let wallet: ActiveWallet;

  beforeAll(async () => {
    wallet = await activeWallet(env);
  }, 600_000);

  it('Wallet crea el enrollment de reemplazo → Recovery envía R′ con KeyAcceptance → U propone → 48 h → U ejecuta → R′ activa', async () => {
    const user = wallet.onboarded.user;
    const walletSession: Session = {
      token: wallet.session.token,
      sessionId: wallet.session.sessionId,
      key: wallet.session.key,
      walletId: wallet.walletId,
    };
    const requested = await critical(
      user.wallet,
      walletSession,
      `/wallets/${wallet.walletId}/recovery/enrollments`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(requested.statusCode, requested.body).toBe(201);
    const { enrollmentId, nonce, purpose } = requested.json<{ enrollmentId: string; nonce: Hex; purpose: string }>();
    expect(purpose).toBe('REPLACEMENT');

    const recoveryKey = newRecoveryKey();
    const enrollment = await stepUp(user.recovery, user.account.email, 'ENROLLMENT');
    const keyResponse = await critical(
      user.recovery,
      enrollment,
      `/recovery/enrollments/${enrollmentId}/enrollment-key`,
      {
        enrollmentKey: recoveryKey.enrollmentKey.jwk,
      },
    );
    expect(keyResponse.statusCode, keyResponse.body).toBe(200);
    const submission = await enrollmentSubmission(env.base, {
      userId: user.account.id,
      enrollmentId,
      nonce,
      recovery: recoveryKey,
    });
    const submit = (body: unknown) =>
      critical(user.recovery, enrollment, `/recovery/enrollments/${enrollmentId}/submit`, body);

    // Sin KeyAcceptance, con otro nonce o firmada por otra clave: rechazo.
    expect((await submit(submission)).statusCode).toBe(400);
    const otherNonce = await submit({
      ...submission,
      keyAcceptance: await keyAcceptance(recoveryKey.account, wallet.walletId, 2),
    });
    expect(otherNonce.statusCode).toBe(409);
    const forged = await submit({
      ...submission,
      keyAcceptance: await keyAcceptance(wallet.recoveryKey, wallet.walletId, 2, nonce),
    });
    expect(forged.statusCode).toBe(422);

    const submitted = await submit({
      ...submission,
      keyAcceptance: await keyAcceptance(recoveryKey.account, wallet.walletId, 2, nonce),
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toMatchObject({ status: 'SUBMITTED', purpose: 'REPLACEMENT' });

    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'R');
    expect(rotation).toMatchObject({ role: 'R', newKey: recoveryKey.account.address, initiatedBy: 'U' });
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    await warpTimelock(env);
    await env.rotationSync().runOnce();
    expect((await rotationRow(env, rotation.id)).status).toBe('READY_TO_EXECUTE');
    const execution = await executePrepare(wallet, { role: 'U' }, rotation.id);
    await signAndExecute(env, wallet, execution.operation, { role: 'U' });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('EXECUTED');
    expect(getAddress((await onchainRoles(wallet)).recoveryKey)).toBe(recoveryKey.account.address);

    const enrollments = await env.base.db.app
      .selectFrom('recovery_metadata')
      .select(['enrollment_id', 'purpose', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .where('status', 'in', ['CONFIRMED', 'RETIRED'])
      .execute();
    expect(enrollments).toContainEqual({ enrollment_id: enrollmentId, purpose: 'REPLACEMENT', status: 'CONFIRMED' });
    expect(enrollments).toContainEqual(expect.objectContaining({ purpose: 'ONBOARDING', status: 'RETIRED' }));
    const view = await user.wallet.get(`/api/v1/recovery/enrollments/${enrollmentId}`);
    expect(view.json()).toMatchObject({ status: 'CONFIRMED', purpose: 'REPLACEMENT' });

    // R′ firma en Recovery: revoca la allowance de USDC (APPROVE_REVOKE con R).
    await resetRateLimits(env.base.redis);
    const session = await recoverySession(wallet);
    const revoke = await recoveryPost(wallet, session, `/wallets/${wallet.walletId}/emergency/revoke-approval`, {
      token: 'USDC',
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    await signAndExecute(env, wallet, revoke.json(), { role: 'R', session }, recoveryKey.account);
  });
});
