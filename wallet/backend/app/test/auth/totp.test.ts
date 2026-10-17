// P09.T06 [B-AUTH-09]: TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) por la API real. Secreto de 160 bits cifrado con
// APP_FIELD_ENCRYPTION_KEY (AES-256-GCM, AAD = userId), anti-replay por paso, 10 códigos de recuperación de un solo uso
// (Argon2id), obligatorio en el login cuando está activo; activar y desactivar rotan la sesión y avisan por email.
import { Secret as OtpSecret, TOTP, URI } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTotpSecret, sealTotpSecret, totpCode } from '../../src/auth/totp.ts';
import { signedInClient, type TestAccount } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import type { TestClient } from '../helpers/client.ts';
import { waitForMessage } from '../helpers/mailpit.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.totp });
});
afterAll(async () => {
  await env.close();
});

const STEP_MS = 30_000;

interface Enrolled {
  browser: TestClient;
  account: TestAccount;
  secret: Buffer;
  recoveryCodes: string[];
}

/** Login, setup y activación con el código actual de la app autenticadora. */
async function enroll(): Promise<Enrolled> {
  const { client: browser, account } = await signedInClient(env.wallet, env.db);
  const setup = await browser.post('/api/v1/auth/totp/setup', {});
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json<{ otpauthUri: string; secret: string }>();
  const raw = Buffer.from(OtpSecret.fromBase32(secret).bytes);
  const enabled = await browser.post('/api/v1/auth/totp/enable', { code: totpCode(raw) });
  expect(enabled.statusCode).toBe(200);
  return { browser, account, secret: raw, recoveryCodes: enabled.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

/** Código del paso siguiente: el actual ya lo consumió la activación (anti-replay). */
const nextCode = (secret: Buffer, steps = 1) => totpCode(secret, Date.now() + steps * STEP_MS);

describe('configuración', () => {
  it('setup devuelve un URI otpauth estándar y un secreto de 160 bits; queda pendiente hasta confirmarlo', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    expect(setup.statusCode).toBe(200);
    const body = setup.json<{ otpauthUri: string; secret: string }>();
    const parsed = URI.parse(body.otpauthUri);
    expect(parsed).toBeInstanceOf(TOTP);
    const totp = parsed as TOTP;
    expect(totp.issuer).toBe('MT Wallet');
    expect(totp.label).toBe(account.email);
    expect(totp.algorithm).toBe('SHA1');
    expect(totp.digits).toBe(6);
    expect(totp.period).toBe(30);
    expect(totp.secret.base32).toBe(body.secret);
    expect(OtpSecret.fromBase32(body.secret).bytes).toHaveLength(20);

    const row = await env.db.app
      .selectFrom('totp_factors')
      .selectAll()
      .where('user_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.enabled_at).toBeNull();
    const me = await browser.get('/api/v1/users/me');
    expect(me.json()).toMatchObject({ totpEnabled: false });
    // El login todavía no pide TOTP.
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: account.password }))
        .statusCode,
    ).toBe(200);
  });

  it('el secreto se guarda cifrado con AES-256-GCM y AAD = userId (no se puede mover a otro usuario)', async () => {
    const { account, secret } = await enroll();
    const row = await env.db.app
      .selectFrom('totp_factors')
      .selectAll()
      .where('user_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_ciphertext.includes(secret)).toBe(false);
    const key = env.wallet.config.secrets.fieldEncryptionKey;
    expect(openTotpSecret(key, account.id, row.secret_ciphertext).equals(secret)).toBe(true);
    expect(() => openTotpSecret(key, crypto.randomUUID(), row.secret_ciphertext)).toThrow();
    // Cifrado autenticado: dos sellados del mismo secreto difieren (IV aleatorio).
    expect(sealTotpSecret(key, account.id, secret).equals(sealTotpSecret(key, account.id, secret))).toBe(false);
    expect(row.recovery_code_hashes).toHaveLength(10);
    for (const hash of row.recovery_code_hashes) expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('activar devuelve 10 códigos de recuperación una sola vez, rota la sesión y avisa por email', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const before = browser.jar.get('__Host-mtw_sid');
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    const raw = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    const enabled = await browser.post('/api/v1/auth/totp/enable', { code: totpCode(raw) });
    expect(enabled.statusCode).toBe(200);
    const { recoveryCodes } = enabled.json<{ recoveryCodes: string[]; csrfToken: string }>();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

    const after = browser.jar.get('__Host-mtw_sid');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    const stale = env.wallet.newClient();
    stale.jar.set('__Host-mtw_sid', before ?? '');
    expect((await stale.get('/api/v1/users/me')).statusCode).toBe(401);
    expect((await browser.get('/api/v1/users/me')).json()).toMatchObject({ totpEnabled: true });
    const revoked = await env.db.app
      .selectFrom('sessions')
      .select('revoke_reason')
      .where('user_id', '=', account.id)
      .where('revoked_at', 'is not', null)
      .execute();
    expect(revoked.map((r) => r.revoke_reason)).toContain('TOTP_CHANGED');

    const notice = await waitForMessage(account.email, (m) =>
      m.subject.includes('Activaste la verificación en dos pasos'),
    );
    expect(notice.text).toContain('Acción: TOTP activado');
    expect(notice.text).not.toContain(recoveryCodes[0] ?? '-');
  });

  it('activar con un código incorrecto es 400 (la sesión sigue), y sin setup o ya activo es 409', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const withoutSetup = await browser.post('/api/v1/auth/totp/enable', { code: '123456' });
    expect(withoutSetup.statusCode).toBe(409);
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    const raw = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    const current = totpCode(raw);
    const wrong = await browser.post('/api/v1/auth/totp/enable', { code: current === '000000' ? '000001' : '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect((await browser.get('/api/v1/users/me')).statusCode).toBe(200);
    expect((await browser.post('/api/v1/auth/totp/enable', { code: current })).statusCode).toBe(200);
    expect((await browser.post('/api/v1/auth/totp/setup', {})).statusCode).toBe(409);
    expect((await browser.post('/api/v1/auth/totp/enable', { code: nextCode(raw) })).statusCode).toBe(409);
  });
});

describe('login con TOTP', () => {
  it('es obligatorio: sin código 401 TOTP_REQUIRED (sólo con la contraseña correcta), con código válido 200', async () => {
    const { account, secret } = await enroll();
    const missing = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: 'TOTP_REQUIRED' });
    expect(missing.headers['set-cookie']).toBeUndefined();
    const wrongPassword = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: `${account.password}x` });
    expect(wrongPassword.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const ok = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password, totp: nextCode(secret) });
    expect(ok.statusCode).toBe(200);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'AUTH_LOGIN_SUCCEEDED')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ method: 'PASSWORD_TOTP' });
  });

  it('un código incorrecto es 401 INVALID_TOTP y cuenta como fallo de login', async () => {
    const { account, secret } = await enroll();
    const valid = nextCode(secret);
    const wrong = valid === '000000' ? '000001' : '000000';
    const response = await env.wallet
      .newClient()
      .post('/api/v1/auth/login', { email: account.email, password: account.password, totp: wrong });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_TOTP' });
    const failed = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'AUTH_LOGIN_FAILED')
      .executeTakeFirstOrThrow();
    expect(failed.payload).toMatchObject({ reason: 'invalid_totp' });
  });

  it('anti-replay: el mismo código no sirve dos veces, ni un paso anterior al último usado', async () => {
    const { account, secret } = await enroll();
    const code = nextCode(secret);
    const login = (totp: string) =>
      env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: account.password, totp });
    expect((await login(code)).statusCode).toBe(200);
    const replay = await login(code);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'INVALID_TOTP' });
    // El código del paso actual (anterior al usado) tampoco.
    expect((await login(totpCode(secret))).statusCode).toBe(401);
  });

  it('un código de recuperación inicia sesión una sola vez (con o sin guion, en minúsculas)', async () => {
    const { account, recoveryCodes } = await enroll();
    const [first = '', second = ''] = recoveryCodes;
    const login = (recoveryCode: string) =>
      env.wallet
        .newClient()
        .post('/api/v1/auth/login', { email: account.email, password: account.password, recoveryCode });
    expect((await login(first)).statusCode).toBe(200);
    expect((await login(first)).statusCode).toBe(401);
    expect((await login(second.replace('-', '').toLowerCase())).statusCode).toBe(200);
    const row = await env.db.app
      .selectFrom('totp_factors')
      .select('recovery_code_hashes')
      .where('user_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(row.recovery_code_hashes).toHaveLength(8);
    const audit = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'AUTH_LOGIN_SUCCEEDED')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.payload).toMatchObject({ method: 'PASSWORD_RECOVERY_CODE' });
  });

  it('TOTP y código de recuperación juntos es un request inválido', async () => {
    const { account, secret, recoveryCodes } = await enroll();
    const response = await env.wallet.newClient().post('/api/v1/auth/login', {
      email: account.email,
      password: account.password,
      totp: nextCode(secret),
      recoveryCode: recoveryCodes[0],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('desactivación', () => {
  it('pide contraseña y un segundo factor; rota la sesión, avisa y el login deja de pedir TOTP', async () => {
    const { browser, account, secret } = await enroll();
    const before = browser.jar.get('__Host-mtw_sid');
    const disabled = await browser.post('/api/v1/auth/totp/disable', {
      password: account.password,
      totp: nextCode(secret),
    });
    expect(disabled.statusCode).toBe(200);
    expect(browser.jar.get('__Host-mtw_sid')).not.toBe(before);
    expect((await browser.get('/api/v1/users/me')).json()).toMatchObject({ totpEnabled: false });
    expect(
      await env.db.app
        .selectFrom('totp_factors')
        .select('user_id')
        .where('user_id', '=', account.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    const notice = await waitForMessage(account.email, (m) =>
      m.subject.includes('Desactivaste la verificación en dos pasos'),
    );
    expect(notice.text).toContain('Acción: TOTP desactivado');
    expect(
      (await env.wallet.newClient().post('/api/v1/auth/login', { email: account.email, password: account.password }))
        .statusCode,
    ).toBe(200);
  });

  it('también con un código de recuperación', async () => {
    const { browser, account, recoveryCodes } = await enroll();
    const response = await browser.post('/api/v1/auth/totp/disable', {
      password: account.password,
      recoveryCode: recoveryCodes[3],
    });
    expect(response.statusCode).toBe(200);
  });

  it('contraseña o código incorrectos: 403 REAUTH_FAILED, la sesión sigue y el fallo cuenta', async () => {
    const { browser, account, secret } = await enroll();
    const badPassword = await browser.post('/api/v1/auth/totp/disable', {
      password: `${account.password}x`,
      totp: nextCode(secret),
    });
    expect(badPassword.statusCode).toBe(403);
    expect(badPassword.json()).toMatchObject({ code: 'REAUTH_FAILED' });
    const current = nextCode(secret, 2);
    const badCode = await browser.post('/api/v1/auth/totp/disable', {
      password: account.password,
      totp: current === '000000' ? '000001' : '000000',
    });
    expect(badCode.statusCode).toBe(403);
    expect((await browser.get('/api/v1/users/me')).json()).toMatchObject({ totpEnabled: true });
    const failures = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'TOTP_DISABLE_FAILED')
      .orderBy('id')
      .execute();
    expect(failures.map((f) => (f.payload as { reason: string }).reason)).toEqual([
      'totp_disable_password',
      'totp_disable_code',
    ]);
    const user = await env.db.app
      .selectFrom('users')
      .select('failed_login_count')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(user.failed_login_count).toBe(2);
  });

  it('exige exactamente un segundo factor y 409 si el TOTP no está activo', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    expect((await browser.post('/api/v1/auth/totp/disable', { password: account.password })).statusCode).toBe(400);
    expect(
      (await browser.post('/api/v1/auth/totp/disable', { password: account.password, totp: '123456' })).statusCode,
    ).toBe(409);
  });
});
