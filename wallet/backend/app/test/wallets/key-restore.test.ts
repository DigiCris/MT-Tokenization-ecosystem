// P12.T01.b [B-PSES-03] contra el fork (Safe desplegada y ACTIVE): KEY_RESTORE = step-up (código del email) + prueba de
// posesión — firma EIP-712 `KeyRestore {userId, walletId, keyAddress, nonce}` de la U restaurada, que tiene que ser el
// rol U vigente on-chain (leído por quórum). Con esa PlatformSession sólo se reemplaza el registro OPAQUE de la misma
// U (p. ej. tras restaurar desde las 17 palabras): la Password U nueva desbloquea y la anterior ya no; la sesión
// KEY_RESTORE se revoca al usarse.
import * as opaque from '@serenity-kit/opaque';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformTypedData } from '../../src/chain/eip712.ts';
import { codeFrom } from '../helpers/mailpit.ts';
import {
  critical,
  deploy,
  idempotencyKey,
  nextStepUpEmail,
  onboard,
  opaqueRecord,
  resetRateLimits,
  startOnboardingEnv,
  stepUp,
  type OnboardedWallet,
  type OnboardingEnv,
  type Session,
} from '../helpers/onboarding.ts';
import { newAuthSecret, newSessionKey, unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;
let active: OnboardedWallet;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.keyRestore });
  active = await onboard(env);
  expect(await deploy(env, active)).toBe('ACTIVE');
}, 900_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

/** Prueba de posesión: firma KeyRestore de `signer` declarando `keyAddress`. */
function proof(o: OnboardedWallet, signer: PrivateKeyAccount, keyAddress: Address = signer.address) {
  return async (nonce: Hex) => ({
    keyAddress,
    signature: await signer.signTypedData(
      platformTypedData(env.wallet.config.chainId, env.snapshot.contracts.walletFactory, 'KeyRestore', {
        userId: o.user.account.id,
        walletId: o.walletId,
        keyAddress,
        nonce,
      }),
    ),
  });
}

/** Step-up KEY_RESTORE a mano (para ver la respuesta del finish). */
async function keyRestoreFinish(o: OnboardedWallet, keyRestore?: (nonce: Hex) => Promise<unknown>) {
  const key = newSessionKey();
  const started = await o.user.wallet.post('/api/v1/platform-sessions/step-up/start', {
    scope: 'KEY_RESTORE',
    sessionPublicKey: key.jwk,
  });
  expect(started.statusCode, started.body).toBe(202);
  const { challengeId, keyRestoreNonce } = started.json<{ challengeId: string; keyRestoreNonce: Hex }>();
  expect(keyRestoreNonce).toMatch(/^0x[0-9a-f]{64}$/);
  const message = await nextStepUpEmail(o.user.account.email);
  expect(message.text).toContain('restaurar tu clave de usuario');
  return o.user.wallet.post('/api/v1/platform-sessions/step-up/finish', {
    challengeId,
    code: codeFrom(message),
    ...(keyRestore === undefined ? {} : { keyRestore: await keyRestore(keyRestoreNonce) }),
  });
}

describe('KEY_RESTORE', () => {
  it('prueba de posesión de la U vigente → nuevo registro OPAQUE: la Password U nueva desbloquea y la vieja no', async () => {
    const session = await stepUp(
      active.user.wallet,
      active.user.account.email,
      'KEY_RESTORE',
      proof(active, active.userKey.account),
    );
    expect(session.walletId).toBe(active.walletId);
    const newSecret = newAuthSecret();
    const registrationRecord = await opaqueRecord(active.user.wallet, session, active.walletId, newSecret);
    const restored = await critical(
      active.user.wallet,
      session,
      `/wallets/${active.walletId}/user-key/restore`,
      {
        registrationRecord,
      },
      { idempotencyKey: idempotencyKey() },
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toEqual({ userKey: active.userKey.account.address, keyVersion: 1, status: 'ACTIVE' });

    const records = await env.db.app
      .selectFrom('opaque_records')
      .select(['status', 'key_version'])
      .where('wallet_id', '=', active.walletId)
      .orderBy('created_at')
      .execute();
    expect(records.map((r) => r.status)).toEqual(['RETIRED', 'ACTIVE']);
    const unlocked = await unlockWallet(active.user.wallet, newSecret);
    expect(unlocked.session).toMatchObject({ scope: 'OPERATIONS', walletId: active.walletId });
    await expect(unlockWallet(active.user.wallet, active.userKey.authSecretHex)).rejects.toThrow();
    // La sesión KEY_RESTORE se usó y quedó revocada.
    const reuse = await critical(
      active.user.wallet,
      session,
      `/wallets/${active.walletId}/user-key/opaque-registration`,
      {
        registrationRequest: opaque.client.startRegistration({ password: newAuthSecret() }).registrationRequest,
      },
    );
    expect(reuse.statusCode).toBe(403);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('wallet_id', '=', active.walletId)
      .where('event_type', '=', 'KEY_RESTORE_COMPLETED')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('sin prueba, con la firma de otra clave o con una clave que no es la U vigente → no hay sesión', async () => {
    await resetRateLimits(env.redis);
    const missing = await keyRestoreFinish(active);
    expect(missing.statusCode).toBe(400);
    // Firma de otra clave declarando la U vigente.
    const forged = await keyRestoreFinish(
      active,
      proof(active, privateKeyToAccount(generatePrivateKey()), active.userKey.account.address),
    );
    expect(forged.statusCode).toBe(422);
    expect(forged.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    // R firma correctamente por sí misma, pero no es la U de la Safe.
    const notU = await keyRestoreFinish(active, proof(active, active.recoveryKey.account));
    expect(notU.statusCode).toBe(422);
    expect(notU.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });
    const sessions = await env.db.app
      .selectFrom('platform_sessions')
      .select('id')
      .where('user_id', '=', active.user.account.id)
      .where('scope', '=', 'KEY_RESTORE')
      .execute();
    expect(sessions).toHaveLength(1);
    // [B-RL]: el step-up de KEY_RESTORE comparte el cupo sensible (3 por día por usuario).
    const limited = await active.user.wallet.post('/api/v1/platform-sessions/step-up/start', {
      scope: 'KEY_RESTORE',
      sessionPublicKey: newSessionKey().jwk,
    });
    expect(limited.statusCode).toBe(429);
  });

  it('sólo con la wallet ACTIVE, sólo en Wallet y la sesión KEY_RESTORE no sirve para el onboarding', async () => {
    await resetRateLimits(env.redis);
    const onboarding = await onboard(env, 'user-key');
    const notActive = await onboarding.user.wallet.post('/api/v1/platform-sessions/step-up/start', {
      scope: 'KEY_RESTORE',
      sessionPublicKey: newSessionKey().jwk,
    });
    expect(notActive.statusCode).toBe(409);
    const inRecovery = await active.user.recovery.post('/api/v1/platform-sessions/step-up/start', {
      scope: 'KEY_RESTORE',
      sessionPublicKey: newSessionKey().jwk,
    });
    expect(inRecovery.statusCode).toBe(403);
    const session = await stepUp(
      active.user.wallet,
      active.user.account.email,
      'KEY_RESTORE',
      proof(active, active.userKey.account),
    );
    const userKey = await critical(
      active.user.wallet,
      session,
      `/wallets/${active.walletId}/user-key`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(userKey.statusCode).toBe(403);
  });
});

describe('cambio de Password U [F-KEY-08]', () => {
  let wallet: OnboardedWallet;
  let secret: string;
  /** Desbloqueo OPAQUE → PlatformSession OPERATIONS en la forma de los helpers de requests críticos. */
  const operations = async (authSecretHex: string): Promise<Session> => {
    const unlocked = await unlockWallet(wallet.user.wallet, authSecretHex);
    return {
      token: unlocked.token,
      sessionId: unlocked.sessionId,
      key: unlocked.key,
      walletId: unlocked.session.walletId,
    };
  };
  const kdfParams = (salt: string) => ({
    alg: 'argon2id',
    version: 19,
    memoryKiB: 65536,
    iterations: 3,
    parallelism: 4,
    salt,
  });
  const metadata = (o: OnboardedWallet) =>
    env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['kdf_params', 'storage_flags'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'U')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    await resetRateLimits(env.redis);
    wallet = await onboard(env);
    expect(await deploy(env, wallet)).toBe('ACTIVE');
    secret = wallet.userKey.authSecretHex;
  }, 900_000);

  it('con OPERATIONS: registro OPAQUE nuevo con los metadatos del sobre nuevo; la Password U vieja ya no desbloquea y sólo sigue la sesión del pedido', async () => {
    const other = await operations(secret);
    const current = await operations(secret);
    const newSecret = newAuthSecret();
    const registrationRecord = await opaqueRecord(wallet.user.wallet, current, wallet.walletId, newSecret);
    const body = {
      registrationRecord,
      kdfParams: kdfParams('AAECAwQFBgcICQoLDA0ODw'),
      storageFlags: { drive: true, file: true, qr: false, words: false },
    };
    const path = `/wallets/${wallet.walletId}/user-key/password`;
    expect((await critical(wallet.user.wallet, current, path, body)).json()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    const changed = await critical(wallet.user.wallet, current, path, body, { idempotencyKey: idempotencyKey() });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ userKey: wallet.userKey.account.address, keyVersion: 1, status: 'ACTIVE' });

    const records = await env.db.app
      .selectFrom('opaque_records')
      .select('status')
      .where('wallet_id', '=', wallet.walletId)
      .orderBy('created_at')
      .execute();
    expect(records.map((r) => r.status)).toEqual(['RETIRED', 'ACTIVE']);
    expect(await metadata(wallet)).toEqual({ kdf_params: body.kdfParams, storage_flags: body.storageFlags });
    await expect(unlockWallet(wallet.user.wallet, secret)).rejects.toThrow();
    const reopened = await unlockWallet(wallet.user.wallet, newSecret);
    expect(reopened.session).toMatchObject({ scope: 'OPERATIONS', walletId: wallet.walletId });
    secret = newSecret;
    const check = (session: Session) => critical(wallet.user.wallet, session, '/platform-sessions/check', {});
    expect((await check(current)).statusCode).toBe(200);
    expect((await check(other)).json()).toMatchObject({ code: 'PLATFORM_SESSION_INVALID' });
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select(['event_type', 'payload'])
      .where('wallet_id', '=', wallet.walletId)
      .where('event_type', '=', 'USER_KEY_PASSWORD_CHANGED')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({ keyVersion: 1, revokedPlatformSessions: 1, kdfMemoryKiB: 65536 });
  });

  it('sin OPERATIONS (KEY_RESTORE) o con un registro inválido no cambia nada', async () => {
    await resetRateLimits(env.redis);
    const restoreSession = await stepUp(
      wallet.user.wallet,
      wallet.user.account.email,
      'KEY_RESTORE',
      proof(wallet, wallet.userKey.account),
    );
    const registrationRecord = await opaqueRecord(wallet.user.wallet, restoreSession, wallet.walletId, newAuthSecret());
    const body = {
      registrationRecord,
      kdfParams: kdfParams('ICEiIyQlJicoKSorLC0uLw'),
      storageFlags: { drive: false, file: true, qr: true, words: false },
    };
    const path = `/wallets/${wallet.walletId}/user-key/password`;
    const wrongScope = await critical(wallet.user.wallet, restoreSession, path, body, {
      idempotencyKey: idempotencyKey(),
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
    const unlocked = await operations(secret);
    const invalid = await critical(
      wallet.user.wallet,
      unlocked,
      path,
      { ...body, registrationRecord: 'A'.repeat(64) },
      { idempotencyKey: idempotencyKey() },
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await metadata(wallet)).storage_flags).toEqual({ drive: true, file: true, qr: false, words: false });
    expect((await unlockWallet(wallet.user.wallet, secret)).session.scope).toBe('OPERATIONS');
  });

  it('KEY_RESTORE con el sobre nuevo actualiza KDF y backups; uno sin el otro es 400', async () => {
    await resetRateLimits(env.redis);
    const session = await stepUp(
      wallet.user.wallet,
      wallet.user.account.email,
      'KEY_RESTORE',
      proof(wallet, wallet.userKey.account),
    );
    const newSecret = newAuthSecret();
    const registrationRecord = await opaqueRecord(wallet.user.wallet, session, wallet.walletId, newSecret);
    const path = `/wallets/${wallet.walletId}/user-key/restore`;
    const half = await critical(
      wallet.user.wallet,
      session,
      path,
      { registrationRecord, kdfParams: kdfParams('MDEyMzQ1Njc4OTo7PD0-Pw') },
      { idempotencyKey: idempotencyKey() },
    );
    expect(half.statusCode).toBe(400);
    const body = {
      registrationRecord,
      kdfParams: kdfParams('MDEyMzQ1Njc4OTo7PD0-Pw'),
      storageFlags: { drive: true, file: false, qr: false, words: true },
    };
    const restored = await critical(wallet.user.wallet, session, path, body, { idempotencyKey: idempotencyKey() });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await metadata(wallet)).toEqual({ kdf_params: body.kdfParams, storage_flags: body.storageFlags });
    expect((await unlockWallet(wallet.user.wallet, newSecret)).session.scope).toBe('OPERATIONS');
    secret = newSecret;
  });
});
