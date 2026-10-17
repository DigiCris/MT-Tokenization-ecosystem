// P10.T04 [B-PSES-03]: step-up por la API real con el email real (Mailpit). Código por email (+ TOTP si está activo)
// → PlatformSession de scope restringido atada a la session key presentada al pedirlo; nunca OPERATIONS; cada scope en
// su listener; ONBOARDING sólo sin wallet ACTIVE; rota la sesión de cuenta.
import { Secret as OtpSecret } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/auth/totp.ts';
import { signedInClient } from '../helpers/accounts.ts';
import { startAccountEnv, type AccountEnv } from '../helpers/account-env.ts';
import type { TestClient } from '../helpers/client.ts';
import { codeFrom, waitForMessage, type MailpitMessage } from '../helpers/mailpit.ts';
import { checkSession, newSessionKey, seedActiveWallet, type SessionKey } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: AccountEnv;

beforeAll(async () => {
  env = await startAccountEnv({ redisDb: REDIS_DBS.stepUp });
});
afterAll(async () => {
  await env.close();
});

const stepUpEmail = (email: string, exclude: readonly string[] = []): Promise<MailpitMessage> =>
  waitForMessage(email, (m) => m.subject.includes('Código de verificación') && !exclude.includes(m.id));

async function startStepUp(browser: TestClient, scope: string, key: SessionKey = newSessionKey()) {
  const response = await browser.post('/api/v1/platform-sessions/step-up/start', { scope, sessionPublicKey: key.jwk });
  return { response, key };
}

describe('step-up', () => {
  it('ONBOARDING sin wallet: código por email → PlatformSession STEP_UP atada a la session key; rota la sesión de cuenta', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const oldCookie = browser.jar.get('__Host-mtw_sid');
    const { response, key } = await startStepUp(browser, 'ONBOARDING');
    expect(response.statusCode).toBe(202);
    const { challengeId } = response.json<{ challengeId: string; expiresAt: string }>();

    const message = await stepUpEmail(account.email);
    expect(message.text).toContain('Acción: Verificación adicional: crear y activar tu wallet');
    expect(message.text).toContain('Red: Base fork local — chainId 8453');
    const finished = await browser.post('/api/v1/platform-sessions/step-up/finish', {
      challengeId,
      code: codeFrom(message),
    });
    expect(finished.statusCode).toBe(200);
    const body = finished.json<{
      token: string;
      csrfToken: string;
      session: { id: string; scope: string; authMethod: string; walletId: string | null };
    }>();
    expect(body.session).toMatchObject({ scope: 'ONBOARDING', authMethod: 'STEP_UP', walletId: null });
    expect(browser.jar.get('__Host-mtw_sid')).not.toBe(oldCookie);
    const stale = env.wallet.newClient();
    stale.jar.set('__Host-mtw_sid', oldCookie ?? '');
    expect((await stale.get('/api/v1/users/me')).statusCode).toBe(401);
    // La PlatformSession funciona con la sesión rotada y la session key presentada al pedir el step-up.
    const check = await checkSession(browser, { token: body.token, sessionId: body.session.id, key });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ scope: 'ONBOARDING' });
    const claims = await env.wallet.services.issuer.verify(body.token);
    expect(claims.sessionPublicKey).toEqual(key.jwk);
  });

  it('ONBOARDING con una wallet en curso queda atada a esa wallet; con la wallet ACTIVE ya no se emite', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const { walletId } = await seedActiveWallet(env.db, {
      userId: account.id,
      platformId: env.wallet.config.platformId,
      status: 'CREATING',
    });
    const { response } = await startStepUp(browser, 'ONBOARDING');
    const finished = await browser.post('/api/v1/platform-sessions/step-up/finish', {
      challengeId: response.json<{ challengeId: string }>().challengeId,
      code: codeFrom(await stepUpEmail(account.email)),
    });
    expect(finished.json()).toMatchObject({ session: { walletId, scope: 'ONBOARDING' } });

    await env.db.app
      .updateTable('wallets')
      .set({ status: 'ACTIVE', safe_address: Buffer.alloc(20, 7) })
      .where('id', '=', walletId)
      .execute();
    const refused = await startStepUp(browser, 'ONBOARDING');
    expect(refused.response.statusCode).toBe(409);
  });

  it('cada scope en su listener: RECOVERY y ENROLLMENT en Recovery; ONBOARDING y U_REPLACEMENT en Wallet', async () => {
    const { client: walletBrowser, account } = await signedInClient(env.wallet, env.db);
    await seedActiveWallet(env.db, { userId: account.id, platformId: env.wallet.config.platformId });
    for (const scope of ['RECOVERY', 'ENROLLMENT']) {
      const { response } = await startStepUp(walletBrowser, scope);
      expect(response.statusCode, scope).toBe(403);
      expect(response.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
    }
    const recoveryBrowser = env.recovery.newClient();
    await recoveryBrowser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    expect((await startStepUp(recoveryBrowser, 'ONBOARDING')).response.statusCode).toBe(403);

    const { response, key } = await startStepUp(recoveryBrowser, 'RECOVERY');
    expect(response.statusCode).toBe(202);
    const message = await stepUpEmail(account.email);
    expect(message.text).toMatch(/^Safe: 0x[0-9A-Fa-f]{4}( [0-9A-Fa-f]{4}){9}$/m);
    const finished = await recoveryBrowser.post('/api/v1/platform-sessions/step-up/finish', {
      challengeId: response.json<{ challengeId: string }>().challengeId,
      code: codeFrom(message),
    });
    expect(finished.statusCode).toBe(200);
    const body = finished.json<{ token: string; session: { id: string; scope: string } }>();
    expect(body.session.scope).toBe('RECOVERY');
    expect(
      (await checkSession(recoveryBrowser, { token: body.token, sessionId: body.session.id, key })).statusCode,
    ).toBe(200);
  });

  it('nunca OPERATIONS ni KEY_RESTORE por step-up; U_REPLACEMENT y RECOVERY exigen la wallet ACTIVE', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    for (const scope of ['OPERATIONS', 'KEY_RESTORE']) {
      const { response } = await startStepUp(browser, scope);
      expect(response.statusCode, scope).toBe(400);
    }
    const replacement = await startStepUp(browser, 'U_REPLACEMENT');
    expect(replacement.response.statusCode).toBe(409);
    expect(replacement.response.json()).toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
  });

  it('con TOTP activo: sin segundo factor 403 (el código no se consume), incorrecto 403, correcto 200', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    const secret = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    await browser.post('/api/v1/auth/totp/enable', { code: totpCode(secret) });

    const { response } = await startStepUp(browser, 'ONBOARDING');
    const challengeId = response.json<{ challengeId: string }>().challengeId;
    const firstMessage = await stepUpEmail(account.email);
    const code = codeFrom(firstMessage);
    const missing = await browser.post('/api/v1/platform-sessions/step-up/finish', { challengeId, code });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
    const next = totpCode(secret, Date.now() + 30_000);
    const wrong = await browser.post('/api/v1/platform-sessions/step-up/finish', {
      challengeId,
      code,
      totp: next === '000000' ? '000001' : '000000',
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: 'REAUTH_FAILED' });
    // El código del email se consumió con el TOTP incorrecto: hace falta uno nuevo.
    const again = await startStepUp(browser, 'ONBOARDING');
    const message = await stepUpEmail(account.email, [firstMessage.id]);
    const ok = await browser.post('/api/v1/platform-sessions/step-up/finish', {
      challengeId: again.response.json<{ challengeId: string }>().challengeId,
      code: codeFrom(message),
      totp: next,
    });
    expect(ok.statusCode).toBe(200);
    const failures = await env.db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('user_id', '=', account.id)
      .where('event_type', '=', 'STEP_UP_FAILED')
      .execute();
    expect(failures.map((f) => (f.payload as { reason?: string }).reason)).toContain('step_up_second_factor');
  });

  it('código incorrecto: 400 y el intento cuenta; tras 5 intentos el challenge se agota', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const { response } = await startStepUp(browser, 'ONBOARDING');
    const challengeId = response.json<{ challengeId: string }>().challengeId;
    const code = codeFrom(await stepUpEmail(account.email));
    for (let i = 0; i < 5; i++) {
      const wrong = String((Number(code) + 1 + i) % 100_000_000).padStart(8, '0');
      const r = await browser.post('/api/v1/platform-sessions/step-up/finish', { challengeId, code: wrong });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    expect((await browser.post('/api/v1/platform-sessions/step-up/finish', { challengeId, code })).statusCode).toBe(
      400,
    );
  });

  it('el step-up se completa desde la misma sesión de cuenta que lo pidió (otro dispositivo no puede usar el código)', async () => {
    const { client: browser, account } = await signedInClient(env.wallet, env.db);
    const { response } = await startStepUp(browser, 'ONBOARDING');
    const challengeId = response.json<{ challengeId: string }>().challengeId;
    const code = codeFrom(await stepUpEmail(account.email));
    const otherDevice = env.wallet.newClient();
    await otherDevice.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const stolen = await otherDevice.post('/api/v1/platform-sessions/step-up/finish', { challengeId, code });
    expect(stolen.statusCode).toBe(400);
    // Y el challenge de otro usuario no existe para este.
    const { client: intruder } = await signedInClient(env.wallet, env.db);
    expect((await intruder.post('/api/v1/platform-sessions/step-up/finish', { challengeId, code })).statusCode).toBe(
      400,
    );
  });

  it('rate limits reales: 3 códigos cada 10 min por usuario y tipo; recovery 3 por día', async () => {
    const { client: browser } = await signedInClient(env.wallet, env.db);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await startStepUp(browser, 'ONBOARDING')).response.statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);

    const { client: walletSide, account } = await signedInClient(env.wallet, env.db);
    await seedActiveWallet(env.db, { userId: account.id, platformId: env.wallet.config.platformId });
    const recoveryBrowser = env.recovery.newClient();
    await recoveryBrowser.post('/api/v1/auth/login', { email: account.email, password: account.password });
    const recoveryCodes: number[] = [];
    for (let i = 0; i < 2; i++)
      recoveryCodes.push((await startStepUp(recoveryBrowser, 'RECOVERY')).response.statusCode);
    for (let i = 0; i < 2; i++)
      recoveryCodes.push((await startStepUp(walletSide, 'U_REPLACEMENT')).response.statusCode);
    // recovery-sensitive (3/día por usuario) es compartido por RECOVERY y U_REPLACEMENT.
    expect(recoveryCodes).toEqual([202, 202, 202, 429]);
  });
});
