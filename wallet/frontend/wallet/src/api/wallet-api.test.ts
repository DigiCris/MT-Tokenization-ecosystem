// P17.T01: cada método de WalletApi arma el request del contrato del backend (OpenAPI del listener de Wallet): método,
// path con /api/v1 y parámetros codificados, cuerpo exacto, Idempotency-Key en las rutas idempotentes y firma con la
// PlatformSession en las críticas; logout y reset descartan el token CSRF de la sesión. Las rotaciones llegan con el
// rol, el estado y los motivos validados: un código que esta app no conoce queda UNKNOWN (revisión de ADR-033).
import { describe, expect, it } from 'vitest';
import { ApiClient, type HttpMethod, type RequestOptions } from './client.ts';
import { generateSessionKey } from './session-key.ts';
import { knownCode, knownRotation, WalletApi, type Rotation } from './wallet-api.ts';

/** Idempotency-Key fijo de prueba (armado en ejecución: no es un secreto, pero tiene forma de clave). */
const IDEMPOTENCY = ['clave', 'idempotente', '0001'].join('-');

/** Una rotación como la manda el backend (los códigos, sin validar). */
const ROTATION = {
  id: 'rot1',
  walletId: 'w1',
  role: 'S',
  oldKey: '0x000000000000000000000000000000000000dEaD',
  newKey: '0x000000000000000000000000000000000000bEEF',
  status: 'DRAFT',
  origin: 'PLATFORM',
  initiatedBy: 'U',
  proposalId: null,
  executableAt: null,
  cancelledBy: null,
  proposeOperationId: null,
  executeOperationId: null,
  proposedAt: null,
  executedAt: null,
  failureReason: null,
  createdAt: '2026-10-25T10:00:00Z',
  cancelTypedData: null,
  requestReason: 'MAINTENANCE',
  newKeyAttestation: null,
  rejectionReason: null,
} as const satisfies Rotation;

/** La respuesta de prueba de cada ruta: la lista o la rotación donde las hay; si no, un objeto vacío. */
function bodyFor(method: HttpMethod, path: string): unknown {
  // Las PlatformSessions emitidas traen la hora del servidor (issuedAt).
  if (path.endsWith('/finish')) return { session: { issuedAt: '2026-10-18T12:00:00Z' } };
  if (method === 'GET' && path.endsWith('/rotations')) return { items: [ROTATION] };
  if (path.endsWith('/rotations') || path.startsWith('/rotations/')) return { rotation: ROTATION };
  return {};
}

interface Call {
  method: HttpMethod;
  path: string;
  options: RequestOptions;
}

class RecordingClient extends ApiClient {
  readonly calls: Call[] = [];
  readonly observed: string[] = [];
  cleared = 0;

  constructor() {
    super({ baseUrl: 'https://api.example/api/v1', fetch: () => Promise.reject(new Error('sin red en este test')) });
  }

  override request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    this.calls.push({ method, path, options });
    return Promise.resolve(bodyFor(method, path) as T);
  }

  override observeServerTime(serverTimeIso: string): void {
    this.observed.push(serverTimeIso);
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
  it('estado de la plataforma (P20.T03): GET público', async () => {
    const client = new RecordingClient();
    await new WalletApi(client).platformStatus();
    expect(client.calls).toEqual([{ method: 'GET', path: '/platform/status', options: {} }]);
  });

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
    // El reloj de las firmas se alinea con la hora del servidor de cada PlatformSession emitida.
    expect(client.observed).toEqual(['2026-10-18T12:00:00Z', '2026-10-18T12:00:00Z']);
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

  it('Safe, operaciones, send, swap, whitelist, rotaciones y migración (P18): método, path, cuerpo y firma', async () => {
    const client = new RecordingClient();
    const api = new WalletApi(client);
    const platform = { token: 'jws', sessionId: 'ps', key: await generateSessionKey() };
    const D = '0x000000000000000000000000000000000000dEaD' as const;
    const authorization = {
      userId: 'u',
      platformId: 'p',
      walletId: 'w1',
      userKey: D,
      recoveryKey: D,
      executor: D,
      saltNonce: '1',
      expectedSafe: D,
      enrollmentNonce: `0x${'1'.repeat(64)}` as const,
    };
    const submission = {
      ownerSignature: `0x${'a'.repeat(130)}` as const,
      ownerRole: 'U' as const,
      submissionEnvelope: {
        operationId: 'o1',
        safeTxHash: `0x${'b'.repeat(64)}` as const,
        sessionId: 'ps',
        submittedAt: 1,
      },
      submissionEnvelopeSignature: 's'.repeat(86),
    };
    await api.createRecoveryEnrollment(platform, 'w1', IDEMPOTENCY);
    await api.getRecoveryEnrollment('e/1');
    await api.assignExecutor(platform, 'w1');
    await api.incorporateRecoveryKey(platform, 'e1', { authorization, signature: `0x${'c'.repeat(130)}` });
    await api.deployWallet(platform, 'w1', IDEMPOTENCY);
    await api.walletDeployment('w1');
    await api.balances('w1');
    await api.transfers('w1', { limit: 5, before: 'c1' });
    await api.operations('w1');
    await api.operation('o1');
    await api.notifications({ unread: true });
    await api.markNotificationRead('n1');
    await api.submitOperationSignature(platform, 'o1', submission, IDEMPOTENCY);
    await api.cancelOperation(platform, 'o1', IDEMPOTENCY);
    await api.requestOperationTwoFactor(platform, 'o1', IDEMPOTENCY);
    await api.confirmOperationTwoFactor(platform, 'o1', '123456', IDEMPOTENCY);
    await api.prepareSend(platform, 'w1', { token: 'USDC', destination: D, amount: '10' }, IDEMPOTENCY);
    await api.swapQuote('w1', { tokenIn: 'USDT', amountIn: '5', slippageBps: 30 });
    await api.prepareSwap(platform, 'w1', { tokenIn: 'USDC', amountIn: '5' }, IDEMPOTENCY);
    await api.operationGroup('g1');
    await api.requoteSwap(platform, 'g1', { slippageBps: 10 }, IDEMPOTENCY);
    await api.revokeSwapApproval(platform, 'g1', IDEMPOTENCY);
    await api.whitelist('w1');
    await api.requestWhitelistDestination(platform, 'w1', { destination: D, label: 'Ana' }, IDEMPOTENCY);
    await api.confirmWhitelistRequest(platform, 'r1', '12345678', IDEMPOTENCY);
    await api.removeWhitelistDestination(platform, 'w1', D, IDEMPOTENCY);
    await api.proposeRotation(platform, 'w1', 'S', IDEMPOTENCY);
    await api.prepareRotationExecution(platform, 'rot1', IDEMPOTENCY);
    await api.relayRotationCancellation('rot1', `0x${'d'.repeat(130)}`);
    await api.prepareMigration(platform, 'old1', IDEMPOTENCY);
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /wallets/w1/recovery/enrollments',
      'GET /recovery/enrollments/e%2F1',
      'POST /wallets/w1/executor',
      'POST /recovery/enrollments/e1/incorporate',
      'POST /wallets/w1/deploy',
      'GET /wallets/w1/deployment',
      'GET /wallets/w1/balances',
      'GET /wallets/w1/transfers?limit=5&before=c1',
      'GET /wallets/w1/operations',
      'GET /operations/o1',
      'GET /notifications?unread=true',
      'POST /notifications/n1/read',
      'POST /operations/o1/signatures',
      'POST /operations/o1/cancel',
      'POST /operations/o1/two-factor',
      'POST /operations/o1/two-factor',
      'POST /wallets/w1/send/prepare',
      'GET /wallets/w1/swap/quote?tokenIn=USDT&amountIn=5&slippageBps=30',
      'POST /wallets/w1/swap/prepare',
      'GET /operation-groups/g1',
      'POST /operation-groups/g1/requote',
      'POST /operation-groups/g1/revoke-approval',
      'GET /wallets/w1/whitelist',
      'POST /wallets/w1/whitelist/requests',
      'POST /whitelist/requests/r1/confirm',
      `POST /wallets/w1/whitelist/${D}/remove`,
      'POST /wallets/w1/rotations',
      'POST /rotations/rot1/execute/prepare',
      'POST /rotations/rot1/cancel',
      'POST /wallets/old1/migration/prepare',
    ]);
    const byPath = (path: string, index = 0) => client.calls.filter((c) => c.path === path)[index]?.options;
    // Críticas: firmadas con la PlatformSession; idempotentes con su clave.
    for (const call of client.calls.filter(
      (c) =>
        (c.method === 'POST' && !c.path.startsWith('/notifications') && !c.path.endsWith('/cancel')) ||
        c.path === '/operations/o1/cancel',
    )) {
      expect(call.options.platform, call.path).toBe(platform);
    }
    expect(byPath('/rotations/rot1/cancel')?.platform).toBeUndefined();
    expect(byPath('/rotations/rot1/cancel')?.body).toEqual({ signature: `0x${'d'.repeat(130)}` });
    expect(byPath('/operations/o1/signatures')).toMatchObject({ body: submission, idempotencyKey: IDEMPOTENCY });
    expect(byPath('/operations/o1/two-factor', 0)?.body).toEqual({});
    expect(byPath('/operations/o1/two-factor', 1)?.body).toEqual({ code: '123456' });
    expect(byPath('/wallets/w1/send/prepare')?.body).toEqual({ token: 'USDC', destination: D, amount: '10' });
    expect(byPath('/wallets/w1/rotations')?.body).toEqual({ role: 'S' });
    expect(byPath('/whitelist/requests/r1/confirm')?.body).toEqual({ code: '12345678' });
    expect(byPath('/recovery/enrollments/e1/incorporate')?.body).toEqual({
      authorization,
      signature: `0x${'c'.repeat(130)}`,
    });
    expect(byPath('/notifications/n1/read')?.body).toEqual({});
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

  it('rotaciones: rol, estado y motivo validados; un código que esta app no conoce queda UNKNOWN', async () => {
    const api = new WalletApi(new RecordingClient());
    expect((await api.listRotations('w1')).items).toEqual([ROTATION]);
    const platform = { token: 'jws', sessionId: 'ps', key: await generateSessionKey() };
    expect((await api.proposeRotation(platform, 'w1', 'S', IDEMPOTENCY)).rotation).toEqual(ROTATION);
    expect((await api.prepareRotationExecution(platform, 'rot1', IDEMPOTENCY)).rotation).toEqual(ROTATION);
    expect((await api.relayRotationCancellation('rot1', `0x${'d'.repeat(130)}`)).rotation).toEqual(ROTATION);
    // Un backend más nuevo o comprometido: ni el texto libre ni una clave del prototipo llegan como código válido.
    const raw = {
      ...ROTATION,
      role: 'ROL_NUEVO',
      status: 'Ejecutá esto en otro sitio',
      requestReason: 'constructor',
    } as unknown as Rotation;
    expect(knownRotation(raw)).toEqual({ ...ROTATION, role: 'UNKNOWN', status: 'UNKNOWN', requestReason: 'UNKNOWN' });
    expect(knownRotation({ ...ROTATION, requestReason: null }).requestReason).toBeNull();
    // Un backend anterior que no manda los motivos: no es un pedido de la plataforma ni un borrador rechazado.
    const { requestReason: _omitted, rejectionReason: _rejection, ...withoutReason } = ROTATION;
    expect(knownRotation(withoutReason as unknown as Rotation)).toMatchObject({
      requestReason: null,
      rejectionReason: null,
    });
    // El borrador del reemplazo de U que canceló la app Recovery ([F-LNK-04]): estado y motivo conocidos o UNKNOWN.
    const rejected = { ...ROTATION, role: 'U', requestReason: null, status: 'REJECTED' } as const;
    expect(knownRotation({ ...rejected, rejectionReason: 'MANUAL_COMPARISON_FAILED' })).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
    });
    expect(
      knownRotation({ ...rejected, rejectionReason: 'Mirá evil.example' } as unknown as Rotation).rejectionReason,
    ).toBe('UNKNOWN');
    expect(knownCode(['A', 'B'], 'B')).toBe('B');
    expect(knownCode(['A', 'B'], 7)).toBe('UNKNOWN');
  });
});
