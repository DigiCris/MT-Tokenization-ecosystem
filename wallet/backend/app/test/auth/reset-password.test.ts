// P09.T04 [B-AUTH-07]: olvido y reset de password por la API real con el email real. Token de 256 bits en el fragmento
// del link del frontend del listener, TTL 30 min, un solo uso; el reset revoca todas las sesiones y PlatformSessions,
// avisa por email y NO toca OPAQUE, metadatos de claves, recovery ni el TOTP (RQ-26).
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUser, randomEmail, randomPassword, signedInClient } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { resetTokenFrom, waitForMessage, type MailpitMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.resetPassword });
});
afterAll(async () => {
  await env.close();
});

const resetEmail = (email: string, exclude: readonly string[] = []): Promise<MailpitMessage> =>
  waitForMessage(email, (m) => m.subject.includes('Restablecé tu contraseña') && !exclude.includes(m.id));

async function requestReset(email: string, listener = env.wallet): Promise<string> {
  const response = await listener.newClient().post('/api/v1/auth/forgot-password', { email });
  expect(response.statusCode).toBe(202);
  return resetTokenFrom(await resetEmail(email));
}

/** Wallet con OPAQUE, metadatos de U/R/S y enrolamiento de recovery (filas que crean P10–P12). */
async function seedWalletData(userId: string): Promise<string> {
  const wallet = await env.db.app
    .insertInto('wallets')
    .values({ user_id: userId, platform_id: env.wallet.config.platformId, chain_id: 8453, status: 'CREATING' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await env.db.app
    .insertInto('opaque_records')
    .values({
      user_id: userId,
      wallet_id: wallet.id,
      key_version: 1,
      registration_record: randomBytes(192),
      key_stretching: JSON.stringify({ algorithm: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 }),
      status: 'ACTIVE',
      activated_at: sql`now()`,
    })
    .execute();
  for (const [role, source] of [
    ['U', 'INTERNAL'],
    ['R', 'EXTERNAL_WALLET'],
    ['S', 'SIGNER_SHARD'],
  ] as const) {
    await env.db.app
      .insertInto('wallet_keys_metadata')
      .values({
        wallet_id: wallet.id,
        role,
        key_address: randomBytes(20),
        key_version: 1,
        status: 'ACTIVE',
        source,
        kdf_params: role === 'U' ? JSON.stringify({ algorithm: 'argon2id', memoryKiB: 262144 }) : null,
        activated_at: sql`now()`,
      })
      .execute();
  }
  await env.db.app
    .insertInto('recovery_metadata')
    .values({
      wallet_id: wallet.id,
      enrollment_id: randomUUID(),
      status: 'REQUESTED',
      expires_at: sql`now() + interval '1 day'`,
    })
    .execute();
  return wallet.id;
}

async function walletSnapshot(userId: string, walletId: string) {
  const [opaque, keys, recovery, wallet, totp] = await Promise.all([
    env.db.app.selectFrom('opaque_records').selectAll().where('user_id', '=', userId).orderBy('id').execute(),
    env.db.app.selectFrom('wallet_keys_metadata').selectAll().where('wallet_id', '=', walletId).orderBy('id').execute(),
    env.db.app.selectFrom('recovery_metadata').selectAll().where('wallet_id', '=', walletId).orderBy('id').execute(),
    env.db.app.selectFrom('wallets').selectAll().where('id', '=', walletId).execute(),
    env.db.app.selectFrom('totp_factors').selectAll().where('user_id', '=', userId).execute(),
  ]);
  return { opaque, keys, recovery, wallet, totp };
}

describe('olvido de contraseña', () => {
  it('envía un link al frontend del listener con el token en el fragmento; misma respuesta si la cuenta no existe', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const browser = env.wallet.newClient();
    const known = await browser.post('/api/v1/auth/forgot-password', { email: account.email });
    const unknown = await browser.post('/api/v1/auth/forgot-password', { email: randomEmail('nadie') });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());

    const message = await resetEmail(account.email);
    const token = resetTokenFrom(message);
    expect(message.text).toContain(`${env.wallet.origin}/reset-password#token=${token}`);
    expect(message.text).not.toContain('?token=');
    expect(message.text).toMatch(/^Vence \(UTC\): .+ UTC$/m);
    expect(message.html).toContain(`href="${env.wallet.origin}/reset-password#token=${token}"`);

    const [challengeId, secret] = token.split('.');
    const challenge = await env.db.app
      .selectFrom('security_challenges')
      .select(['type', 'expires_at', 'created_at', 'code_hash'])
      .where('id', '=', challengeId ?? '')
      .executeTakeFirstOrThrow();
    expect(challenge.type).toBe('PASSWORD_RESET');
    expect(Buffer.from(secret ?? '', 'base64url')).toHaveLength(32);
    const ttlMinutes = (challenge.expires_at.getTime() - challenge.created_at.getTime()) / 60_000;
    expect(Math.round(ttlMinutes)).toBe(30);
  });

  it('desde el listener de Recovery el link apunta al frontend de Recovery', async () => {
    const account = await createVerifiedUser(env.recovery, env.db);
    await env.recovery.newClient().post('/api/v1/auth/forgot-password', { email: account.email });
    const message = await resetEmail(account.email);
    expect(message.subject).toContain('Restablecé tu contraseña');
    expect(message.text).toContain(`${env.recovery.origin}/reset-password#token=`);
    expect(message.text).toContain('MT Wallet Recovery');
  });
});

describe('reset de contraseña', () => {
  it('cambia la contraseña, revoca todas las sesiones y PlatformSessions y avisa por email', async () => {
    const { client: walletSession, account } = await signedInClient(env.wallet, env.db);
    const recoverySession = env.recovery.newClient();
    await recoverySession.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const sessionIds = await env.db.app
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', account.id)
      .where('revoked_at', 'is', null)
      .execute();
    expect(sessionIds).toHaveLength(2);
    const platform = await env.db.app
      .insertInto('platform_sessions')
      .values({
        account_session_id: sessionIds[0]?.id ?? '',
        user_id: account.id,
        scope: 'ONBOARDING',
        auth_method: 'STEP_UP',
        session_public_key_jwk: JSON.stringify({ kty: 'OKP' }),
        issued_at: sql`now()`,
        expires_at: sql`now() + interval '10 minutes'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const token = await requestReset(account.email);
    const newPassword = randomPassword();
    const reset = await env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword });
    expect(reset.statusCode).toBe(204);
    expect(reset.headers['set-cookie']).toBeUndefined();

    expect((await walletSession.get('/api/v1/users/me')).statusCode).toBe(401);
    expect((await recoverySession.get('/api/v1/users/me')).statusCode).toBe(401);
    const revoked = await env.db.app
      .selectFrom('sessions')
      .select('revoke_reason')
      .where('user_id', '=', account.id)
      .execute();
    expect(revoked.map((r) => r.revoke_reason)).toEqual(['PASSWORD_RESET', 'PASSWORD_RESET']);
    const platformRow = await env.db.app
      .selectFrom('platform_sessions')
      .select('revoked_at')
      .where('id', '=', platform.id)
      .executeTakeFirstOrThrow();
    expect(platformRow.revoked_at).not.toBeNull();

    const old = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(old.statusCode).toBe(401);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: newPassword }))
        .statusCode,
    ).toBe(200);

    const notice = await waitForMessage(account.email, (m) => m.subject.includes('Tu contraseña cambió'));
    expect(notice.text).toContain('Se cerraron todas tus sesiones');
    expect(notice.text).toContain('Tus claves de la wallet no cambiaron');
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'AUTH_PASSWORD_RESET_COMPLETED')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ revokedSessions: 2 });
  });

  it('el reset no modifica opaque_records, metadatos de claves, recovery, la wallet ni el TOTP (RQ-26)', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const walletId = await seedWalletData(account.id);
    await env.db.app
      .insertInto('totp_factors')
      .values({
        user_id: account.id,
        secret_ciphertext: randomBytes(48),
        enabled_at: sql`now()`,
        last_used_step: '1000',
      })
      .execute();
    await env.db.app.updateTable('users').set({ totp_enabled: true }).where('id', '=', account.id).execute();
    const before = await walletSnapshot(account.id, walletId);
    const userBefore = await env.db.app
      .selectFrom('users')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();

    const token = await requestReset(account.email);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword: randomPassword() }))
        .statusCode,
    ).toBe(204);

    expect(await walletSnapshot(account.id, walletId)).toEqual(before);
    const userAfter = await env.db.app
      .selectFrom('users')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    const { password_hash: hashBefore, updated_at: _ub, ...restBefore } = userBefore;
    const { password_hash: hashAfter, updated_at: _ua, ...restAfter } = userAfter;
    expect(hashAfter).not.toBe(hashBefore);
    expect(restAfter).toEqual(restBefore);
    expect(userAfter.totp_enabled).toBe(true);
  });

  it('desbloquea una cuenta bloqueada y verifica un email pendiente (abrir el link prueba el control de la casilla)', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    await env.db.app
      .updateTable('users')
      .set({ status: 'LOCKED', email_verified_at: null, failed_login_count: 12 })
      .where('id', '=', account.id)
      .execute();
    const token = await requestReset(account.email);
    const newPassword = randomPassword();
    expect((await env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword })).statusCode).toBe(
      204,
    );
    const row = await env.db.app
      .selectFrom('users')
      .select(['status', 'email_verified_at', 'failed_login_count'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'ACTIVE', failed_login_count: 0 });
    expect(row.email_verified_at).toBeInstanceOf(Date);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: newPassword }))
        .statusCode,
    ).toBe(200);
  });

  it('una contraseña nueva débil es 422 y no consume el token', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const token = await requestReset(account.email);
    const browser = env.wallet.newClient();
    // Una de la lista de comunes (armada en runtime: un literal así parece una credencial para los escáneres).
    const common = ['qwerty', '123456'].join('');
    const weak = await browser.post('/api/v1/auth/reset-password', { token, newPassword: common });
    expect(weak.statusCode).toBe(422);
    expect(weak.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe('body.newPassword');
    expect(
      (await browser.post('/api/v1/auth/reset-password', { token, newPassword: randomPassword() })).statusCode,
    ).toBe(204);
  });

  it('tokens mal formados, inexistentes o de otro tipo son 400 INVALID_TOKEN', async () => {
    const browser = env.wallet.newClient();
    // Un challenge vivo de otro tipo (verificación de email de un registro real) no sirve como token de reset.
    const pendingEmail = randomEmail('pendiente');
    await browser.post('/api/v1/auth/register', { email: pendingEmail, password: randomPassword() });
    const verification = await env.db.app
      .selectFrom('security_challenges as c')
      .innerJoin('users as u', 'u.id', 'c.user_id')
      .select('c.id')
      .where('u.email', '=', pendingEmail)
      .where('c.type', '=', 'EMAIL_VERIFY')
      .executeTakeFirstOrThrow();
    const otherType = `${verification.id}.${randomBytes(32).toString('base64url')}`;
    for (const token of ['sin-formato', `${randomUUID()}.${randomBytes(32).toString('base64url')}`, otherType]) {
      const response = await browser.post('/api/v1/auth/reset-password', { token, newPassword: randomPassword() });
      expect(response.statusCode, token).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    }
  });

  it('una cuenta deshabilitada no recibe el link', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ status: 'DISABLED' }).where('id', '=', account.id).execute();
    const response = await env.wallet.newClient().post('/api/v1/auth/forgot-password', { email: account.email });
    expect(response.statusCode).toBe(202);
    const challenges = await env.db.app
      .selectFrom('security_challenges')
      .select('id')
      .where('user_id', '=', account.id)
      .execute();
    expect(challenges).toEqual([]);
  });
});
