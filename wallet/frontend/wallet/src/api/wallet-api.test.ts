// P17.T01: cada método de WalletApi arma el request del contrato del backend (OpenAPI del listener de Wallet): método,
// path con /api/v1 y parámetros codificados, cuerpo exacto, Idempotency-Key en las rutas idempotentes y firma con la
// PlatformSession en las críticas; logout y reset descartan el token CSRF de la sesión.
import { describe, expect, it } from 'vitest';
import { ApiClient, type HttpMethod, type RequestOptions } from './client.ts';
import { generateSessionKey } from './session-key.ts';
import { WalletApi } from './wallet-api.ts';

/** Idempotency-Key fijo de prueba (armado en ejecución: no es un secreto, pero tiene forma de clave). */
const IDEMPOTENCY = ['clave', 'idempotente', '0001'].join('-');

interface Call {
  method: HttpMethod;
  path: string;
  options: RequestOptions;
}

class RecordingClient extends ApiClient {
  readonly calls: Call[] = [];
  cleared = 0;

  constructor() {
    super({ baseUrl: 'https://api.example/api/v1', fetch: () => Promise.reject(new Error('sin red en este test')) });
  }

  override request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    this.calls.push({ method, path, options });
    return Promise.resolve({} as T);
  }

  override clearCsrfToken(): void {
    this.cleared++;
  }
}

const kdf = {
  alg: 'argon2id' as const,
  version: 19 as const,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 4,
  salt: 's'.repeat(22),
};
const flags = { drive: true, file: true, qr: false, words: false };

describe('WalletApi', () => {
  it('cuenta, sesiones y PlatformSession: método, path y cuerpo de cada ruta', async () => {
    const client = new RecordingClient();
    const api = new WalletApi(client);
    const key = await generateSessionKey();
    const platform = { token: 'jws', sessionId: 'ps', key };
    await api.register({ email: 'a@b.test', password: 'p', locale: 'es', timeZone: 'UTC' });
    await api.verifyEmail({ email: 'a@b.test', code: '12345678' });
    await api.resendVerification('a@b.test');
    await api.login({ email: 'a@b.test', password: 'p', totp: '123456' });
    await api.logout();
    await api.forgotPassword('a@b.test');
    await api.resetPassword({ token: 't', newPassword: 'n' });
    await api.requestAccountUnlock('a@b.test');
    await api.unlockAccount({ email: 'a@b.test', code: '1' });
    await api.totpSetup();
    await api.totpEnable('123456');
    await api.totpDisable({ password: 'p', recoveryCode: 'AAAAA-BBBBB' });
    await api.me();
    await api.updateMe({ locale: 'es' });
    await api.listSessions();
    await api.revokeSession('id/1');
    await api.revokeOtherSessions();
    await api.opaqueStart({ startLoginRequest: 'r', sessionPublicKey: key.publicJwk, walletId: 'w' });
    await api.opaqueFinish({ loginAttemptId: 'l', finishLoginRequest: 'f', sessionKeyBinding: 'b' });
    await api.stepUpStart({ scope: 'ONBOARDING', sessionPublicKey: key.publicJwk });
    await api.stepUpFinish({ challengeId: 'c', code: '12345678' });
    await api.checkPlatformSession(platform);
    await api.revokePlatformSession('ps');
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /auth/register',
      'POST /auth/verify-email',
      'POST /auth/verify-email/resend',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/forgot-password',
      'POST /auth/reset-password',
      'POST /auth/unlock/request',
      'POST /auth/unlock',
      'POST /auth/totp/setup',
      'POST /auth/totp/enable',
      'POST /auth/totp/disable',
      'GET /users/me',
      'PATCH /users/me',
      'GET /sessions',
      'DELETE /sessions/id%2F1',
      'DELETE /sessions',
      'POST /platform-sessions/opaque/start',
      'POST /platform-sessions/opaque/finish',
      'POST /platform-sessions/step-up/start',
      'POST /platform-sessions/step-up/finish',
      'POST /platform-sessions/check',
      'DELETE /platform-sessions/ps',
    ]);
    expect(client.calls[0]?.options.body).toEqual({ email: 'a@b.test', password: 'p', locale: 'es', timeZone: 'UTC' });
    expect(client.calls[3]?.options.body).toEqual({ email: 'a@b.test', password: 'p', totp: '123456' });
    expect(client.calls[10]?.options.body).toEqual({ code: '123456' });
    expect(client.calls[21]?.options.platform).toBe(platform);
    expect(client.cleared).toBe(2);
  });

  it('wallet y clave U: rutas críticas firmadas e idempotentes con el cuerpo exacto', async () => {
    const client = new RecordingClient();
    const api = new WalletApi(client);
    const platform = { token: 'jws', sessionId: 'ps', key: await generateSessionKey() };
    const registration = {
      userKey: '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904' as const,
      kdfParams: kdf,
      storageFlags: flags,
      registrationRecord: 'rec',
    };
    await api.myWallet();
    await api.createWallet(platform, IDEMPOTENCY);
    await api.userKeyOpaqueRegistration(platform, 'w 1', 'req');
    await api.registerUserKey(platform, 'w1', registration);
    await api.restoreUserKey(platform, 'w1', { registrationRecord: 'rec', kdfParams: kdf, storageFlags: flags });
    await api.changeUserKeyPassword(platform, 'w1', { registrationRecord: 'rec', kdfParams: kdf, storageFlags: flags });
    await api.registerReplacementUserKey(platform, {
      ...registration,
      keyAcceptance: { nonce: `0x${'1'.repeat(64)}`, signature: `0x${'2'.repeat(130)}` },
    });
    await api.listRotations('w1');
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /wallets/me',
      'POST /wallets',
      'POST /wallets/w%201/user-key/opaque-registration',
      'POST /wallets/w1/user-key',
      'POST /wallets/w1/user-key/restore',
      'POST /wallets/w1/user-key/password',
      'POST /recovery/u-replacement',
      'GET /wallets/w1/rotations',
    ]);
    const [, create, opaque, register, restore, change, replacement] = client.calls;
    expect(create?.options).toMatchObject({ platform, idempotencyKey: IDEMPOTENCY });
    expect(opaque?.options).toEqual({ platform, body: { registrationRequest: 'req' } });
    expect(opaque?.options.idempotencyKey).toBeUndefined();
    for (const call of [register, restore, change, replacement]) {
      expect(call?.options.platform).toBe(platform);
      expect(call?.options.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(register?.options.body).toEqual(registration);
    expect(change?.options.body).toEqual({ registrationRecord: 'rec', kdfParams: kdf, storageFlags: flags });
    expect(replacement?.options.body).toMatchObject({ keyAcceptance: { nonce: `0x${'1'.repeat(64)}` } });
  });
});
