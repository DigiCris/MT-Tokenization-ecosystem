// Escenarios por las APIs reales (P12/P15) para los tests de Recovery: la parte de la app Wallet la hace Node con código
// propio de estos tests —cuenta verificada (código real por Mailpit), step-up ONBOARDING, U con su registro OPAQUE
// (AuthSecret_U aleatorio: el backend sólo guarda el registro), S asignada por el signer, autorización de U para la
// factory, deploy por el gas tank— y la de Recovery, la UI (enroll) o Node (R interna o externa con su prueba de
// control). También la sesión OPERATIONS de U (OPAQUE) para preparar y firmar operaciones con U.
import * as opaque from '@serenity-kit/opaque';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { type ApiClient, newIdempotencyKey, type PlatformAuth } from '../../../../src/api/client.ts';
import { canonicalize } from '../../../../src/api/jcs.ts';
import type { PlatformSessionView, User } from '../../../../src/api/recovery-api.ts';
import { generateSessionKey, jwkThumbprint, signP256 } from '../../../../src/api/session-key.ts';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  toBufferSource,
  utf8,
} from '../../../../src/crypto/encoding.ts';
import { nextCode } from './mailpit.ts';
import { ACCOUNT_PASSWORD, recoveryApi, uniqueEmail, walletClient } from './api.ts';
import { freshClientIp, stack, walletFactory } from './stack.ts';

const KEY_STRETCHING = { 'argon2id-custom': { memory: 16384, iterations: 1, parallelism: 1 } } as const;

export interface Account {
  email: string;
  password: string;
  user: User;
  /** Cliente del listener de Wallet con la sesión de la cuenta. */
  wallet: ApiClient;
}

export interface Session {
  platform: PlatformAuth;
  view: PlatformSessionView;
}

/** Cuenta registrada y verificada (código real por Mailpit), con sesión abierta en el listener de Wallet. */
export async function verifiedAccount(prefix?: string): Promise<Account> {
  freshClientIp();
  const wallet = walletClient();
  const email = uniqueEmail(prefix);
  await wallet.request('POST', '/auth/register', { body: { email, password: ACCOUNT_PASSWORD } });
  const { user } = await wallet.request<{ user: User }>('POST', '/auth/verify-email', {
    body: { email, code: await nextCode(email) },
  });
  return { email, password: ACCOUNT_PASSWORD, user, wallet };
}

/** Step-up por email en un listener: PlatformSession con una session key P-256 nueva y no extraíble. */
export async function stepUp(
  client: ApiClient,
  email: string,
  scope: 'ONBOARDING' | 'U_REPLACEMENT' | 'ENROLLMENT' | 'RECOVERY',
  walletId?: string,
): Promise<Session> {
  const key = await generateSessionKey();
  const started = await client.request<{ challengeId: string }>('POST', '/platform-sessions/step-up/start', {
    body: { scope, sessionPublicKey: key.publicJwk, ...(walletId === undefined ? {} : { walletId }) },
  });
  const issued = await client.request<{ token: string; session: PlatformSessionView }>(
    'POST',
    '/platform-sessions/step-up/finish',
    { body: { challengeId: started.challengeId, code: await nextCode(email) } },
  );
  client.clock.observe(issued.session.issuedAt);
  return { platform: { token: issued.token, sessionId: issued.session.id, key: key.privateKey }, view: issued.session };
}

function kdfParams() {
  return {
    alg: 'argon2id',
    version: 19,
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 4,
    salt: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  } as const;
}

async function opaqueRecord(
  client: ApiClient,
  platform: PlatformAuth,
  walletId: string,
  authSecret: Uint8Array,
): Promise<string> {
  await opaque.ready;
  const password = bytesToHex(authSecret).slice(2);
  const start = opaque.client.startRegistration({ password });
  const { registrationResponse } = await client.request<{ registrationResponse: string }>(
    'POST',
    `/wallets/${walletId}/user-key/opaque-registration`,
    { platform, body: { registrationRequest: start.registrationRequest } },
  );
  return opaque.client.finishRegistration({
    clientRegistrationState: start.clientRegistrationState,
    registrationResponse,
    password,
    keyStretching: KEY_STRETCHING,
  }).registrationRecord;
}

export interface UserKey {
  account: PrivateKeyAccount;
  /** AuthSecret_U del registro OPAQUE (para la sesión OPERATIONS). */
  authSecret: Uint8Array;
}

export interface Onboarding {
  account: Account;
  walletId: string;
  onboarding: Session;
  user: UserKey;
  enrollment: { enrollmentId: string; nonce: Hex };
}

/**
 * Wallet con U registrada y el pedido de enrollment de R creado (lo que la Wallet manda a Recovery por el link). Con una
 * cuenta existente, es otra wallet de esa cuenta (p. ej. la Safe nueva de una migración excepcional).
 */
export async function onboardUntilEnrollment(prefix?: string, existing?: Account): Promise<Onboarding> {
  const account = existing ?? (await verifiedAccount(prefix));
  const onboarding = await stepUp(account.wallet, account.email, 'ONBOARDING');
  const created = await account.wallet.request<{ id: string }>('POST', '/wallets', {
    platform: onboarding.platform,
    idempotencyKey: newIdempotencyKey(),
  });
  const user: UserKey = {
    account: privateKeyToAccount(generatePrivateKey()),
    authSecret: crypto.getRandomValues(new Uint8Array(32)),
  };
  const registrationRecord = await opaqueRecord(account.wallet, onboarding.platform, created.id, user.authSecret);
  await account.wallet.request('POST', `/wallets/${created.id}/user-key`, {
    platform: onboarding.platform,
    idempotencyKey: newIdempotencyKey(),
    body: {
      userKey: user.account.address,
      kdfParams: kdfParams(),
      storageFlags: { drive: false, file: true, qr: false, words: true },
      registrationRecord,
    },
  });
  const enrollment = await account.wallet.request<{ enrollmentId: string; nonce: Hex }>(
    'POST',
    `/wallets/${created.id}/recovery/enrollments`,
    { platform: onboarding.platform, idempotencyKey: newIdempotencyKey() },
  );
  return { account, walletId: created.id, onboarding, user, enrollment };
}

/** La parte de Recovery por API: login, step-up ENROLLMENT, Enrollment Key, prueba de control de R y envío. */
export async function submitRecoveryByApi(state: Onboarding, r: PrivateKeyAccount): Promise<void> {
  const api = recoveryApi();
  await api.login({ email: state.account.email, password: ACCOUNT_PASSWORD });
  const session = await stepUp(api.client, state.account.email, 'ENROLLMENT', state.walletId);
  const enrollmentKey = await generateSessionKey();
  await api.registerEnrollmentKey(session.platform, state.enrollment.enrollmentId, enrollmentKey.publicJwk);
  const issuedAt = new Date(Date.now() - 1_000);
  const object = {
    userId: state.account.user.id,
    platformId: stack().platformId,
    R: getAddress(r.address),
    nonce: state.enrollment.nonce,
    issuedAt: issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const proofOfControl = await r.signTypedData({
    domain: { name: 'MTW Wallet', version: '1', chainId: 8453, verifyingContract: walletFactory() },
    types: {
      RecoveryProofOfControl: [
        { name: 'userId', type: 'string' },
        { name: 'platformId', type: 'string' },
        { name: 'enrollmentId', type: 'string' },
        { name: 'recoveryKey', type: 'address' },
      ],
    },
    primaryType: 'RecoveryProofOfControl',
    message: {
      userId: state.account.user.id,
      platformId: stack().platformId,
      enrollmentId: state.enrollment.enrollmentId,
      recoveryKey: object.R,
    },
  });
  await api.submitEnrollment(session.platform, state.enrollment.enrollmentId, {
    enrollment: object,
    enrollmentKeySignature: await signP256(enrollmentKey.privateKey, canonicalize(object)),
    rType: 'INTERNAL',
    proofOfControl,
    storageFlags: { drive: false, file: true, qr: false, words: false },
  });
}

export interface ActiveWallet extends Onboarding {
  safe: Address;
  /** R de la wallet (null si la R es la del enrollment hecho en la UI y no se conoce acá). */
  recovery: PrivateKeyAccount | null;
}

/** Con R enviada (UI o API): S del signer, autorización de U para la factory, deploy y espera de la Safe ACTIVE. */
export async function finishOnboarding(state: Onboarding, recovery: PrivateKeyAccount | null): Promise<ActiveWallet> {
  const { wallet } = state.account;
  const plan = await wallet.request<{
    typedData: {
      domain: { name: string; version: string; chainId: number; verifyingContract: Address };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, string>;
    };
  }>('POST', `/wallets/${state.walletId}/executor`, { platform: state.onboarding.platform });
  const { domain, types, primaryType, message } = plan.typedData;
  const signature = await state.user.account.signTypedData({
    domain,
    types,
    primaryType,
    message: { ...message, saltNonce: BigInt(message.saltNonce ?? '0') },
  });
  await wallet.request('POST', `/recovery/enrollments/${state.enrollment.enrollmentId}/incorporate`, {
    platform: state.onboarding.platform,
    body: { authorization: message, signature },
  });
  await wallet.request('POST', `/wallets/${state.walletId}/deploy`, {
    platform: state.onboarding.platform,
    idempotencyKey: newIdempotencyKey(),
  });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const { wallet: view } = await wallet.request<{ wallet: { status: string; safe: Address | null } | null }>(
      'GET',
      '/wallets/me',
    );
    if (view?.status === 'ACTIVE' && view.safe) return { ...state, safe: getAddress(view.safe), recovery };
    if (view?.status === 'FAILED' || Date.now() > deadline) {
      throw new Error(`la wallet no quedó ACTIVE (${view?.status ?? 'sin wallet'})`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
}

/** Onboarding completo por API con una R conocida (interna por defecto: la que la app Recovery tendría cifrada). */
export async function activeWallet(
  prefix?: string,
  recovery: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
): Promise<ActiveWallet & { recovery: PrivateKeyAccount }> {
  const state = await onboardUntilEnrollment(prefix);
  await submitRecoveryByApi(state, recovery);
  return { ...(await finishOnboarding(state, recovery)), recovery };
}

/** Sesión OPERATIONS de U por OPAQUE (lo que hace la Wallet al desbloquear), para preparar y firmar con U. */
export async function operationsSession(state: ActiveWallet): Promise<Session> {
  await opaque.ready;
  const { wallet } = state.account;
  const key = await generateSessionKey();
  const password = bytesToHex(state.user.authSecret).slice(2);
  const login = opaque.client.startLogin({ password });
  const started = await wallet.request<{ loginAttemptId: string; loginResponse: string }>(
    'POST',
    '/platform-sessions/opaque/start',
    { body: { startLoginRequest: login.startLoginRequest, sessionPublicKey: key.publicJwk, walletId: state.walletId } },
  );
  const finished = opaque.client.finishLogin({
    clientLoginState: login.clientLoginState,
    loginResponse: started.loginResponse,
    password,
    keyStretching: KEY_STRETCHING,
  });
  if (!finished) throw new Error('OPAQUE rechazó el login de U');
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(base64UrlToBytes(finished.sessionKey)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const binding = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      hmacKey,
      toBufferSource(utf8(`${await jwkThumbprint(key.publicJwk)}${started.loginAttemptId}`)),
    ),
  );
  const issued = await wallet.request<{ token: string; session: PlatformSessionView }>(
    'POST',
    '/platform-sessions/opaque/finish',
    {
      body: {
        loginAttemptId: started.loginAttemptId,
        finishLoginRequest: finished.finishLoginRequest,
        sessionKeyBinding: bytesToBase64Url(binding),
      },
    },
  );
  wallet.clock.observe(issued.session.issuedAt);
  return { platform: { token: issued.token, sessionId: issued.session.id, key: key.privateKey }, view: issued.session };
}

/**
 * "Perdí mi Password U" de la Wallet por API: step-up U_REPLACEMENT, U′ nueva con su registro OPAQUE y la KeyAcceptance
 * que firma U′ → la rotación U → U′ queda en borrador para que R la proponga desde Recovery.
 */
export async function replaceUserKey(state: ActiveWallet): Promise<{ rotationId: string; newUser: UserKey }> {
  const { wallet } = state.account;
  const session = await stepUp(wallet, state.account.email, 'U_REPLACEMENT');
  const newUser: UserKey = {
    account: privateKeyToAccount(generatePrivateKey()),
    authSecret: crypto.getRandomValues(new Uint8Array(32)),
  };
  const registrationRecord = await opaqueRecord(wallet, session.platform, state.walletId, newUser.authSecret);
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const signature = await newUser.account.signTypedData({
    domain: { name: 'MTW Wallet', version: '1', chainId: 8453, verifyingContract: walletFactory() },
    types: {
      KeyAcceptance: [
        { name: 'walletId', type: 'string' },
        { name: 'role', type: 'uint8' },
        { name: 'newKey', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'KeyAcceptance',
    message: { walletId: state.walletId, role: 1, newKey: newUser.account.address, nonce },
  });
  const registered = await wallet.request<{ rotationId: string }>('POST', '/recovery/u-replacement', {
    platform: session.platform,
    idempotencyKey: newIdempotencyKey(),
    body: {
      userKey: newUser.account.address,
      kdfParams: kdfParams(),
      storageFlags: { drive: false, file: true, qr: false, words: false },
      registrationRecord,
      keyAcceptance: { nonce, signature },
    },
  });
  return { rotationId: registered.rotationId, newUser };
}
