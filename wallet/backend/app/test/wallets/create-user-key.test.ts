// P12.T01: con la PlatformSession ONBOARDING (step-up), POST /wallets crea la wallet en CREATING (o devuelve la que está
// en curso) y POST /wallets/{id}/user-key registra la dirección de U, el KDF público, los backups confirmados (al menos
// uno que no dependa de la plataforma) y el registro OPAQUE PENDING (el registro OPAQUE es real: paso 1 en el servidor,
// paso 2 en el cliente). U se puede reemplazar hasta que autoriza la creación; nunca puede ser una clave de otra wallet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  critical,
  idempotencyKey,
  KDF_PARAMS,
  newOnboardingUser,
  newUserKey,
  onboard,
  opaqueRecord,
  startOnboardingEnv,
  stepUp,
  type OnboardingEnv,
} from '../helpers/onboarding.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OnboardingEnv;

beforeAll(async () => {
  env = await startOnboardingEnv({ redisDb: REDIS_DBS.walletCreateUserKey });
}, 600_000);
afterAll(async () => {
  await (env as OnboardingEnv | undefined)?.close();
});

const BACKUPS = { drive: true, file: true, qr: false, words: false };

describe('alta de la wallet y registro de U', () => {
  it('POST /wallets crea la wallet CREATING; repetirlo retoma la misma; el Idempotency-Key repite la respuesta', async () => {
    const user = await newOnboardingUser(env);
    const session = await stepUp(user.wallet, user.account.email, 'ONBOARDING');
    expect(session.walletId).toBeNull();
    const key = idempotencyKey();
    const created = await critical(user.wallet, session, '/wallets', {}, { idempotencyKey: key });
    expect(created.statusCode, created.body).toBe(201);
    const wallet = created.json<{ id: string; status: string; safe: string | null; chainId: number }>();
    expect(wallet).toMatchObject({ status: 'CREATING', safe: null, chainId: 8453 });
    const replay = await critical(user.wallet, session, '/wallets', {}, { idempotencyKey: key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const resumed = await critical(user.wallet, session, '/wallets', {}, { idempotencyKey: idempotencyKey() });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ id: wallet.id, status: 'CREATING' });
    expect((await user.wallet.get('/api/v1/wallets/me')).json()).toMatchObject({ wallet: { id: wallet.id } });
    // Sin PlatformSession o sin firma del request no hay alta.
    expect((await user.wallet.post('/api/v1/wallets', {}, { 'idempotency-key': idempotencyKey() })).statusCode).toBe(
      403,
    );
    // Un step-up ONBOARDING nuevo ya queda atado a la wallet en curso.
    expect((await stepUp(user.wallet, user.account.email, 'ONBOARDING')).walletId).toBe(wallet.id);
  });

  it('U con KDF y backups: registro OPAQUE PENDING atado a (wallet, versión 1) y metadata pública', async () => {
    const o = await onboard(env, 'user-key');
    const u = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['key_address', 'status', 'source', 'key_version', 'kdf_params', 'storage_flags'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'U')
      .executeTakeFirstOrThrow();
    expect(u).toMatchObject({ status: 'PENDING', source: 'INTERNAL', key_version: 1, kdf_params: KDF_PARAMS });
    expect(`0x${u.key_address.toString('hex')}`).toBe(o.userKey.account.address.toLowerCase());
    const records = await env.db.app
      .selectFrom('opaque_records')
      .select(['status', 'key_version', 'key_stretching'])
      .where('wallet_id', '=', o.walletId)
      .execute();
    expect(records).toEqual([
      {
        status: 'PENDING',
        key_version: 1,
        key_stretching: { version: 1, 'argon2id-custom': { memory: 16384, iterations: 1, parallelism: 1 } },
      },
    ]);
    // Con el registro PENDING la Wallet todavía no se puede desbloquear (OPERATIONS exige wallet ACTIVE).
    const started = await o.user.wallet.post('/api/v1/platform-sessions/opaque/start', {
      startLoginRequest: 'x'.repeat(96),
      sessionPublicKey: o.onboarding.key.jwk,
    });
    expect(started.statusCode).toBe(409);
  });

  it('valida backups, KDF y dirección; un mensaje OPAQUE inválido no registra nada', async () => {
    const o = await onboard(env, 'user-key');
    const userKey = newUserKey();
    const registrationRecord = await opaqueRecord(o.user.wallet, o.onboarding, o.walletId, userKey.authSecretHex);
    const register = (body: Record<string, unknown>) =>
      critical(o.user.wallet, o.onboarding, `/wallets/${o.walletId}/user-key`, body, {
        idempotencyKey: idempotencyKey(),
      });
    const valid = {
      userKey: userKey.account.address,
      kdfParams: KDF_PARAMS,
      storageFlags: BACKUPS,
      registrationRecord,
    };
    // Sólo Drive (depende de la plataforma) no alcanza ([F-KEY-06]).
    const driveOnly = await register({ ...valid, storageFlags: { drive: true, file: false, qr: false, words: false } });
    expect(driveOnly.statusCode).toBe(400);
    expect((await register({ ...valid, kdfParams: { ...KDF_PARAMS, memoryKiB: 1024 } })).statusCode).toBe(400);
    expect((await register({ ...valid, userKey: '0x0000000000000000000000000000000000000000' })).statusCode).toBe(400);
    expect((await register({ ...valid, registrationRecord: 'A'.repeat(40) })).statusCode).toBe(400);
    // Campos de más (p. ej. calldata) no se aceptan.
    expect((await register({ ...valid, initializer: '0x1234' })).statusCode).toBe(400);
    // Reemplazo de U antes de autorizar la creación: la anterior queda REVOKED y vale la nueva.
    const replaced = await register(valid);
    expect(replaced.statusCode, replaced.body).toBe(201);
    const keys = await env.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['key_address', 'status'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'U')
      .orderBy('created_at')
      .execute();
    expect(keys.map((k) => k.status)).toEqual(['REVOKED', 'PENDING']);
    expect(`0x${keys[1]?.key_address.toString('hex')}`).toBe(userKey.account.address.toLowerCase());
  });

  it('U no puede ser una clave de otra wallet; la wallet de otro usuario es 404 y otra sesión es 403', async () => {
    const a = await onboard(env, 'user-key');
    const b = await onboard(env, 'user-key');
    const record = await opaqueRecord(b.user.wallet, b.onboarding, b.walletId, a.userKey.authSecretHex);
    const reused = await critical(
      b.user.wallet,
      b.onboarding,
      `/wallets/${b.walletId}/user-key`,
      { userKey: a.userKey.account.address, kdfParams: KDF_PARAMS, storageFlags: BACKUPS, registrationRecord: record },
      { idempotencyKey: idempotencyKey() },
    );
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'KEY_NOT_ALLOWED' });
    // B no ve ni toca la wallet de A (404, no 403: sin enumeración).
    expect((await b.user.wallet.get(`/api/v1/wallets/${a.walletId}/deployment`)).statusCode).toBe(404);
    const foreign = await critical(
      b.user.wallet,
      b.onboarding,
      `/wallets/${a.walletId}/recovery/enrollments`,
      {},
      {
        idempotencyKey: idempotencyKey(),
      },
    );
    expect(foreign.statusCode).toBe(404);
    // Una sesión ENROLLMENT (Recovery) no sirve para registrar U en Wallet.
    const enrollment = await stepUp(a.user.recovery, a.user.account.email, 'ENROLLMENT');
    const wrongScope = await critical(
      a.user.wallet,
      enrollment,
      `/wallets/${a.walletId}/user-key/opaque-registration`,
      {
        registrationRequest: 'A'.repeat(64),
      },
    );
    expect(wrongScope.statusCode).toBe(403);
  });
});
