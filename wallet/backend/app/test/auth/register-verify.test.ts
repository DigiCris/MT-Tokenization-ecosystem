// P09.T01 [B-AUTH-01/02]: registro y verificación de email por la API real, con el email real (outbox → BullMQ →
// worker → SMTP de Mailpit). OTP de 8 dígitos guardado como HMAC(OTP_HMAC_KEY, challengeId:código), un solo uso,
// 5 intentos, TTL 15 min; sin enumeración de usuarios en el registro.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashChallengeSecret, secretsMatch } from '../../src/auth/otp.ts';
import { randomEmail, randomPassword } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import { codeFrom, messagesTo, waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.registerVerify });
});
afterAll(async () => {
  await env.close();
});

/** Email de verificación para la dirección, ignorando los ya leídos. */
const verificationEmail = (email: string, exclude: readonly string[] = []) =>
  waitForMessage(email, (m) => m.subject.includes('Verificá tu email') && !exclude.includes(m.id));

async function userRow(email: string) {
  return env.db.app
    .selectFrom('users')
    .select(['id', 'email', 'email_verified_at', 'password_hash', 'status', 'locale', 'time_zone'])
    .where('email', '=', email)
    .executeTakeFirst();
}

describe('registro', () => {
  it('registra, envía el código por email y la verificación abre la sesión', async () => {
    const email = randomEmail('alta');
    const password = randomPassword();
    const browser = env.wallet.newClient();
    const registered = await browser.post('/api/v1/auth/register', { email, password });
    expect(registered.statusCode).toBe(202);
    expect(registered.json()).toEqual({ status: 'ACCEPTED' });
    expect(registered.headers['set-cookie']).toBeUndefined();

    const message = await verificationEmail(email);
    expect(message.subject).toBe('[MTW local] Verificá tu email');
    const code = codeFrom(message);
    expect(code).toMatch(/^\d{8}$/);
    expect(message.text).toContain('Acción: Verificación de email de la cuenta');
    // Sin zona horaria del navegador: UTC, en una sola fila.
    expect(message.text).toMatch(/^Vence \(UTC\): .+ UTC$/m);
    expect(message.text).not.toMatch(/^Vence: /m);
    expect(message.text).toContain(`IP ${browser.remoteAddress.split('.').slice(0, 3).join('.')}.0/24`);
    expect(message.headers['X-Mtw-Ref']?.[0]).toMatch(/^[0-9a-f-]{36}$/);

    const pending = await userRow(email);
    expect(pending?.email_verified_at).toBeNull();
    expect(pending?.locale).toBe('es-AR');
    expect(pending?.time_zone).toBe('UTC');

    const verified = await browser.post('/api/v1/auth/verify-email', { email, code });
    expect(verified.statusCode).toBe(200);
    const body = verified.json<{ user: { id: string; email: string; emailVerified: boolean }; csrfToken: string }>();
    expect(body.user).toMatchObject({ email, emailVerified: true, totpEnabled: false });
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser.jar.has('__Host-mtw_sid')).toBe(true);

    const me = await browser.get('/api/v1/users/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: body.user.id, email, emailVerified: true });
    expect((await userRow(email))?.email_verified_at).toBeInstanceOf(Date);

    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('user_id', '=', body.user.id)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual([
      'AUTH_REGISTRATION_REQUESTED',
      'AUTH_EMAIL_VERIFIED',
      'AUTH_LOGIN_SUCCEEDED',
    ]);
  });

  it('el código sólo existe como HMAC(OTP_HMAC_KEY, challengeId:código): ni la base ni el outbox lo tienen en claro', async () => {
    const email = randomEmail('hmac');
    await env.wallet.newClient().post('/api/v1/auth/register', { email, password: randomPassword() });
    const code = codeFrom(await verificationEmail(email));
    const user = await userRow(email);
    const challenge = await env.db.app
      .selectFrom('security_challenges')
      .selectAll()
      .where('user_id', '=', user?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(challenge.type).toBe('EMAIL_VERIFY');
    expect(challenge.max_attempts).toBe(5);
    const ttlMinutes = (challenge.expires_at.getTime() - challenge.created_at.getTime()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(14.9);
    expect(ttlMinutes).toBeLessThan(15.1);
    const expected = hashChallengeSecret(env.wallet.config.secrets.otpHmacKey, challenge.id, code);
    expect(secretsMatch(challenge.code_hash, expected)).toBe(true);
    expect(Buffer.from(challenge.code_hash).toString('utf8')).not.toContain(code);

    const outbox = await env.db.app
      .selectFrom('outbox_events')
      .select(['payload'])
      .where('aggregate_type', '=', 'email')
      .execute();
    const serialized = JSON.stringify(outbox);
    expect(serialized).toContain(email);
    expect(serialized).not.toContain(code);
    const jobs = await env.redis.keys('*');
    for (const key of jobs) {
      const type = await env.redis.type(key);
      if (type === 'hash') expect(JSON.stringify(await env.redis.hgetall(key))).not.toContain(code);
    }
  });

  it('un código incorrecto no verifica y cuenta el intento; el correcto lo consume (un solo uso)', async () => {
    const email = randomEmail('uso');
    const browser = env.wallet.newClient();
    await browser.post('/api/v1/auth/register', { email, password: randomPassword() });
    const code = codeFrom(await verificationEmail(email));
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const failed = await browser.post('/api/v1/auth/verify-email', { email, code: wrong });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ code: 'INVALID_CODE' });
    const user = await userRow(email);
    const attempts = await env.db.app
      .selectFrom('security_challenges')
      .select('attempts')
      .where('user_id', '=', user?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(attempts.attempts).toBe(1);

    expect((await browser.post('/api/v1/auth/verify-email', { email, code })).statusCode).toBe(200);
    const again = await env.wallet.newClient().post('/api/v1/auth/verify-email', { email, code });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: 'INVALID_CODE' });
  });

  it('valida la password: corta, común o con el email → 422 WEAK_PASSWORD sin crear la cuenta', async () => {
    const browser = env.wallet.newClient();
    for (const [password, message] of [
      ['corta-2026', 'al menos 12'],
      ['q1w2e3r4t5y6', 'demasiado común'],
      ['clave-de-maria.lopez-77', 'tu email'],
    ] as const) {
      const email = password.startsWith('clave')
        ? `maria.lopez@${randomEmail('d').split('@')[0] ?? ''}.test.invalid`
        : randomEmail('debil');
      const response = await browser.post('/api/v1/auth/register', { email, password });
      expect(response.statusCode, password).toBe(422);
      const problem = response.json<{ code: string; errors: { path: string; message: string }[] }>();
      expect(problem.code).toBe('WEAK_PASSWORD');
      expect(problem.errors[0]?.path).toBe('body.password');
      expect(problem.errors[0]?.message).toContain(message);
      expect(response.body).not.toContain(password);
      expect(await userRow(email)).toBeUndefined();
    }
  });

  it('toma el idioma y la zona horaria del navegador para los emails desde el primero', async () => {
    const email = randomEmail('zona');
    await env.wallet.newClient().post('/api/v1/auth/register', {
      email,
      password: randomPassword(),
      locale: 'en-US',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    const message = await verificationEmail(email);
    expect(message.text).toMatch(/^Vence: .+ \(America\/Argentina\/Buenos_Aires\)$/m);
    expect(message.text).toMatch(/^Vence \(UTC\): .+ UTC$/m);
    expect(await userRow(email)).toMatchObject({ locale: 'en-US', time_zone: 'America/Argentina/Buenos_Aires' });
    const invalid = await env.wallet.newClient().post('/api/v1/auth/register', {
      email: randomEmail('mala'),
      password: randomPassword(),
      timeZone: 'Marte/Olympus',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('normaliza el email (NFKC, minúsculas, espacios) y lo trata como una sola cuenta', async () => {
    const local = randomEmail('Mayus').split('@')[0] ?? '';
    const typed = `${local.toUpperCase()}@TEST.INVALID`;
    const browser = env.wallet.newClient();
    expect((await browser.post('/api/v1/auth/register', { email: typed, password: randomPassword() })).statusCode).toBe(
      202,
    );
    const normalized = `${local.toLowerCase()}@test.invalid`;
    const row = await userRow(normalized);
    expect(row?.email).toBe(normalized);
    const code = codeFrom(await verificationEmail(normalized));
    expect((await browser.post('/api/v1/auth/verify-email', { email: typed, code })).statusCode).toBe(200);
  });

  it('sin enumeración: un email ya verificado responde igual, avisa al dueño y no cambia su contraseña', async () => {
    const email = randomEmail('existente');
    const original = randomPassword();
    const owner = env.wallet.newClient();
    await owner.post('/api/v1/auth/register', { email, password: original });
    await owner.post('/api/v1/auth/verify-email', { email, code: codeFrom(await verificationEmail(email)) });
    const before = await userRow(email);

    const intruder = env.wallet.newClient();
    const attempt = await intruder.post('/api/v1/auth/register', { email, password: randomPassword() });
    const fresh = await intruder.post('/api/v1/auth/register', {
      email: randomEmail('nuevo'),
      password: randomPassword(),
    });
    expect(attempt.statusCode).toBe(fresh.statusCode);
    expect(attempt.json()).toEqual(fresh.json());
    expect(Object.keys(attempt.headers).sort()).toEqual(Object.keys(fresh.headers).sort());

    const warning = await waitForMessage(email, (m) => m.subject.includes('Intento de registro'));
    expect(warning.text).toContain('Tu email ya tiene una cuenta');
    expect(warning.text).not.toMatch(/Código: \d{8}/);
    expect((await userRow(email))?.password_hash).toBe(before?.password_hash);
    const login = await env.wallet.newClient().post('/api/v1/auth/login', { email, password: original });
    expect(login.statusCode).toBe(200);
  });

  it('una cuenta sin verificar se puede volver a registrar: vale la última contraseña y el último código', async () => {
    const email = randomEmail('reintento');
    const first = env.wallet.newClient();
    await first.post('/api/v1/auth/register', { email, password: randomPassword() });
    const firstMessage = await verificationEmail(email);
    const oldCode = codeFrom(firstMessage);

    const secondPassword = randomPassword();
    const second = env.wallet.newClient();
    await second.post('/api/v1/auth/register', { email, password: secondPassword });
    const newCode = codeFrom(await verificationEmail(email, [firstMessage.id]));
    expect(newCode).not.toBe(oldCode);
    expect(await messagesTo(email)).toHaveLength(2);

    expect((await first.post('/api/v1/auth/verify-email', { email, code: oldCode })).statusCode).toBe(400);
    expect((await second.post('/api/v1/auth/verify-email', { email, code: newCode })).statusCode).toBe(200);
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email, password: secondPassword })).statusCode,
    ).toBe(200);
  });

  it('reenvío: manda un código nuevo e invalida el anterior; misma respuesta para un email inexistente', async () => {
    const email = randomEmail('reenvio');
    const browser = env.wallet.newClient();
    await browser.post('/api/v1/auth/register', { email, password: randomPassword() });
    const first = await verificationEmail(email);
    const firstCode = codeFrom(first);

    const resent = await browser.post('/api/v1/auth/verify-email/resend', { email });
    const unknown = await browser.post('/api/v1/auth/verify-email/resend', { email: randomEmail('nadie') });
    expect(resent.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(resent.json()).toEqual(unknown.json());

    const second = await verificationEmail(email, [first.id]);
    const secondCode = codeFrom(second);
    expect((await browser.post('/api/v1/auth/verify-email', { email, code: firstCode })).statusCode).toBe(400);
    expect((await browser.post('/api/v1/auth/verify-email', { email, code: secondCode })).statusCode).toBe(200);
  });

  it('login antes de verificar: 403 EMAIL_NOT_VERIFIED sólo con la contraseña correcta (y reenvía el código)', async () => {
    const email = randomEmail('sinverificar');
    const password = randomPassword();
    await env.wallet.newClient().post('/api/v1/auth/register', { email, password });
    const first = await verificationEmail(email);

    const wrong = await env.wallet.newClient().post('/api/v1/auth/login', { email, password: `${password}x` });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const right = await env.wallet.newClient().post('/api/v1/auth/login', { email, password });
    expect(right.statusCode).toBe(403);
    expect(right.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(right.headers['set-cookie']).toBeUndefined();
    const resent = await verificationEmail(email, [first.id]);
    expect(codeFrom(resent)).not.toBe(codeFrom(first));
  });

  it('verificar desbloquea una cuenta bloqueada y nunca abre sesión en una deshabilitada', async () => {
    const lockedEmail = randomEmail('bloqueada');
    const password = randomPassword();
    await env.wallet.newClient().post('/api/v1/auth/register', { email: lockedEmail, password });
    const lockedCode = codeFrom(await verificationEmail(lockedEmail));
    await env.db.app
      .updateTable('users')
      .set({ status: 'LOCKED', failed_login_count: 10 })
      .where('email', '=', lockedEmail)
      .execute();
    const browser = env.wallet.newClient();
    expect((await browser.post('/api/v1/auth/verify-email', { email: lockedEmail, code: lockedCode })).statusCode).toBe(
      200,
    );
    expect(await userRow(lockedEmail)).toMatchObject({ status: 'ACTIVE' });
    expect((await env.wallet.newClient().post('/api/v1/auth/login', { email: lockedEmail, password })).statusCode).toBe(
      200,
    );

    const disabledEmail = randomEmail('deshabilitada');
    await env.wallet.newClient().post('/api/v1/auth/register', { email: disabledEmail, password: randomPassword() });
    const disabledCode = codeFrom(await verificationEmail(disabledEmail));
    await env.db.app.updateTable('users').set({ status: 'DISABLED' }).where('email', '=', disabledEmail).execute();
    const rejected = env.wallet.newClient();
    const response = await rejected.post('/api/v1/auth/verify-email', { email: disabledEmail, code: disabledCode });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect(rejected.jar.has('__Host-mtw_sid')).toBe(false);
    expect((await userRow(disabledEmail))?.email_verified_at).toBeNull();
  });

  it('el reenvío y el registro respetan [B-RL] otp-challenge (3 cada 10 min por email y tipo)', async () => {
    const email = randomEmail('limite');
    const browser = env.wallet.newClient();
    expect((await browser.post('/api/v1/auth/register', { email, password: randomPassword() })).statusCode).toBe(202);
    expect((await browser.post('/api/v1/auth/verify-email/resend', { email })).statusCode).toBe(202);
    expect((await browser.post('/api/v1/auth/verify-email/resend', { email })).statusCode).toBe(202);
    const limited = await browser.post('/api/v1/auth/verify-email/resend', { email });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
