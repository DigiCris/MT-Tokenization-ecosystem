// P09.TST.d [B-AUTH-02/07/08]: OTP vencido, reusado y con más de 5 intentos (verificación de email y desbloqueo), y
// token de reset reusado, reemplazado por un pedido nuevo, vencido o agotado. Todo por la API con el email real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUser, randomEmail, randomPassword } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { codeFrom, resetTokenFrom, waitForMessage, type MailpitMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.otpReset });
});
afterAll(async () => {
  await env.close();
});

const bySubject = (email: string, subject: string, exclude: readonly string[] = []): Promise<MailpitMessage> =>
  waitForMessage(email, (m) => m.subject.includes(subject) && !exclude.includes(m.id));
const otherCode = (code: string, i = 0) => String((Number(code) + 1 + i) % 100_000_000).padStart(8, '0');

async function registered(): Promise<{ email: string; code: string }> {
  const email = randomEmail('otp');
  await env.wallet.newClient().post('/api/v1/auth/register', { email, password: randomPassword() });
  return { email, code: codeFrom(await bySubject(email, 'Verificá tu email')) };
}

async function challengeOf(email: string, type: 'EMAIL_VERIFY' | 'LOGIN_UNLOCK' | 'PASSWORD_RESET') {
  return env.db.app
    .selectFrom('security_challenges as c')
    .innerJoin('users as u', 'u.id', 'c.user_id')
    .select(['c.id', 'c.attempts', 'c.consumed_at', 'c.expires_at'])
    .where('u.email', '=', email)
    .where('c.type', '=', type)
    .orderBy('c.created_at', 'desc')
    .executeTakeFirstOrThrow();
}

describe('OTP de verificación de email', () => {
  it('vencido: el código correcto ya no sirve', async () => {
    const { email, code } = await registered();
    const challenge = await challengeOf(email, 'EMAIL_VERIFY');
    await env.db.admin.query(`UPDATE security_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      challenge.id,
    ]);
    const response = await env.wallet.newClient().post('/api/v1/auth/verify-email', { email, code });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_CODE' });
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('event_type', '=', 'AUTH_EMAIL_VERIFICATION_FAILED')
      .where('request_id', '=', response.json<{ requestId: string }>().requestId)
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ result: 'EXPIRED' });
  });

  it('reusado: un código ya consumido no vuelve a verificar ni abre otra sesión', async () => {
    const { email, code } = await registered();
    expect((await env.wallet.newClient().post('/api/v1/auth/verify-email', { email, code })).statusCode).toBe(200);
    const replay = env.wallet.newClient();
    const response = await replay.post('/api/v1/auth/verify-email', { email, code });
    expect(response.statusCode).toBe(400);
    expect(replay.jar.has('__Host-mtw_sid')).toBe(false);
  });

  it('más de 5 intentos: tras 5 fallos ni el código correcto sirve (agotado)', async () => {
    const { email, code } = await registered();
    const browser = env.wallet.newClient();
    for (let i = 0; i < 5; i++) {
      expect((await browser.post('/api/v1/auth/verify-email', { email, code: otherCode(code, i) })).statusCode).toBe(
        400,
      );
    }
    expect((await challengeOf(email, 'EMAIL_VERIFY')).attempts).toBe(5);
    const exhausted = await browser.post('/api/v1/auth/verify-email', { email, code });
    expect(exhausted.statusCode).toBe(400);
    expect((await challengeOf(email, 'EMAIL_VERIFY')).consumed_at).toBeNull();
    const user = await env.db.app
      .selectFrom('users')
      .select('email_verified_at')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    expect(user.email_verified_at).toBeNull();
  });

  it('los intentos se cuentan aunque se repartan entre listeners e IPs', async () => {
    const { email, code } = await registered();
    for (let i = 0; i < 5; i++) {
      const listener = i % 2 === 0 ? env.wallet : env.recovery;
      await listener.newClient().post('/api/v1/auth/verify-email', { email, code: otherCode(code, i) });
    }
    expect((await env.recovery.newClient().post('/api/v1/auth/verify-email', { email, code })).statusCode).toBe(400);
  });
});

describe('OTP de desbloqueo', () => {
  async function lockedAccount() {
    const account = await createVerifiedUser(env.wallet, env.db);
    await env.db.app.updateTable('users').set({ status: 'LOCKED' }).where('id', '=', account.id).execute();
    await env.wallet.newClient().post('/api/v1/auth/unlock/request', { email: account.email });
    return { account, code: codeFrom(await bySubject(account.email, 'Desbloqueá tu cuenta')) };
  }

  it('desbloquea una sola vez con el código correcto', async () => {
    const { account, code } = await lockedAccount();
    const browser = env.wallet.newClient();
    expect((await browser.post('/api/v1/auth/unlock', { email: account.email, code })).statusCode).toBe(204);
    const row = await env.db.app
      .selectFrom('users')
      .select('status')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ACTIVE');
    expect((await browser.post('/api/v1/auth/unlock', { email: account.email, code })).statusCode).toBe(400);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: account.password }))
        .statusCode,
    ).toBe(200);
  });

  it('vencido o con más de 5 intentos no desbloquea', async () => {
    const expired = await lockedAccount();
    const challenge = await challengeOf(expired.account.email, 'LOGIN_UNLOCK');
    await env.db.admin.query(`UPDATE security_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      challenge.id,
    ]);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/unlock', { email: expired.account.email, code: expired.code }))
        .statusCode,
    ).toBe(400);

    const exhausted = await lockedAccount();
    const browser = env.wallet.newClient();
    for (let i = 0; i < 5; i++)
      await browser.post('/api/v1/auth/unlock', { email: exhausted.account.email, code: otherCode(exhausted.code, i) });
    expect(
      (await browser.post('/api/v1/auth/unlock', { email: exhausted.account.email, code: exhausted.code })).statusCode,
    ).toBe(400);
    const row = await env.db.app
      .selectFrom('users')
      .select('status')
      .where('id', '=', exhausted.account.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('LOCKED');
  });

  it('un pedido nuevo dentro de los 2 minutos no genera otro código (no se puede inundar la casilla)', async () => {
    const { account } = await lockedAccount();
    await env.wallet.newClient().post('/api/v1/auth/unlock/request', { email: account.email });
    const challenges = await env.db.app
      .selectFrom('security_challenges')
      .select('id')
      .where('user_id', '=', account.id)
      .where('type', '=', 'LOGIN_UNLOCK')
      .execute();
    expect(challenges).toHaveLength(1);
  });
});

describe('token de reset', () => {
  async function resetToken(email: string, exclude: readonly string[] = []) {
    await env.wallet.newClient().post('/api/v1/auth/forgot-password', { email });
    const message = await bySubject(email, 'Restablecé tu contraseña', exclude);
    return { token: resetTokenFrom(message), messageId: message.id };
  }
  const reset = (token: string) =>
    env.wallet.newClient().post('/api/v1/auth/reset-password', { token, newPassword: randomPassword() });

  it('reusado: un token ya usado es 400 INVALID_TOKEN', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const { token } = await resetToken(account.email);
    expect((await reset(token)).statusCode).toBe(204);
    const again = await reset(token);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('reemplazado: un pedido nuevo invalida el token anterior', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const first = await resetToken(account.email);
    const second = await resetToken(account.email, [first.messageId]);
    expect(second.token).not.toBe(first.token);
    expect((await reset(first.token)).statusCode).toBe(400);
    expect((await reset(second.token)).statusCode).toBe(204);
  });

  it('vencido a los 30 minutos', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const { token } = await resetToken(account.email);
    await env.db.admin.query(`UPDATE security_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      token.split('.')[0],
    ]);
    expect((await reset(token)).statusCode).toBe(400);
  });

  it('agotado: 5 secretos incorrectos para el mismo challenge lo inutilizan', async () => {
    const account = await createVerifiedUser(env.wallet, env.db);
    const { token } = await resetToken(account.email);
    const [id] = token.split('.');
    for (let i = 0; i < 5; i++) {
      const wrong = `${id ?? ''}.${Buffer.alloc(32, i + 1).toString('base64url')}`;
      expect((await reset(wrong)).statusCode).toBe(400);
    }
    expect((await reset(token)).statusCode).toBe(400);
    const login = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode).toBe(200);
  });
});
