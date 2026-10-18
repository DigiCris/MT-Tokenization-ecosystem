// Rutas del listener de Wallet que usa la app (contrato: OpenAPI del backend, `GET /docs/openapi.json`). Cada método
// es un request tipado sobre ApiClient; los críticos llevan la PlatformSession que exige su scope ([W-07]).
import type { Address } from 'viem';
import type { KdfParams } from '../crypto/kdf.ts';
import { newIdempotencyKey, type ApiClient } from './client.ts';
import type { PlatformAuth } from './request-signature.ts';
import type { P256PublicJwk } from './session-key.ts';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  locale: string;
  timeZone: string;
  createdAt: string;
}

export interface AccountSession {
  id: string;
  client: 'WALLET' | 'RECOVERY';
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipPrefix: string | null;
  userAgent: string | null;
  current: boolean;
}

export type WalletStatus =
  | 'CREATING'
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'ACTIVE'
  | 'SOVEREIGN_MODIFIED'
  | 'MIGRATING'
  | 'FAILED'
  | 'MIGRATED'
  | 'ABANDONED';

export interface WalletView {
  id: string;
  status: WalletStatus;
  chainId: number;
  safe: Address | null;
  createdAt: string;
  activatedAt: string | null;
}

export type PlatformScope = 'OPERATIONS' | 'ONBOARDING' | 'RECOVERY' | 'U_REPLACEMENT' | 'ENROLLMENT' | 'KEY_RESTORE';
export type StepUpScope = 'ONBOARDING' | 'U_REPLACEMENT' | 'KEY_RESTORE';

export interface PlatformSessionView {
  id: string;
  scope: PlatformScope;
  authMethod: 'OPAQUE_U' | 'STEP_UP';
  walletId: string | null;
  safe: Address | null;
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedPlatformSession {
  token: string;
  session: PlatformSessionView;
}

/** Backups confirmados de la clave ([F-KEY-06]). */
export interface StorageFlags {
  drive: boolean;
  file: boolean;
  qr: boolean;
  words: boolean;
}

export interface UserKeyRegistration {
  userKey: Address;
  kdfParams: KdfParams;
  storageFlags: StorageFlags;
  registrationRecord: string;
}

export interface Rotation {
  id: string;
  walletId: string;
  role: 'U' | 'R' | 'S' | 'GUARD' | 'MODULE_GUARD';
  oldKey: Address;
  newKey: Address;
  status:
    | 'DRAFT'
    | 'AWAITING_SIGNATURE'
    | 'PROPOSING'
    | 'PENDING_TIMELOCK'
    | 'READY_TO_EXECUTE'
    | 'EXECUTING'
    | 'EXECUTED'
    | 'CANCELLED'
    | 'FAILED';
  origin: 'PLATFORM' | 'ONCHAIN';
  initiatedBy: 'U' | 'R' | 'SAFE';
  executableAt: string | null;
  createdAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
}

export interface StepUpFinishInput {
  challengeId: string;
  code: string;
  totp?: string;
  recoveryCode?: string;
  keyRestore?: { keyAddress: Address; signature: `0x${string}` };
}

const enc = encodeURIComponent;

export class WalletApi {
  readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  // --- Cuenta ([B-AUTH]) ------------------------------------------------------------------------------------------

  register(input: { email: string; password: string; locale?: string; timeZone?: string }) {
    return this.client.request<{ status: 'ACCEPTED' }>('POST', '/auth/register', { body: input });
  }

  verifyEmail(input: { email: string; code: string }) {
    return this.client.request<{ user: User; csrfToken: string }>('POST', '/auth/verify-email', { body: input });
  }

  resendVerification(email: string) {
    return this.client.request<{ status: 'ACCEPTED' }>('POST', '/auth/verify-email/resend', { body: { email } });
  }

  login(input: LoginInput) {
    return this.client.request<{ user: User; csrfToken: string }>('POST', '/auth/login', { body: input });
  }

  async logout(): Promise<void> {
    try {
      await this.client.request<undefined>('POST', '/auth/logout');
    } finally {
      this.client.clearCsrfToken();
    }
  }

  forgotPassword(email: string) {
    return this.client.request<{ status: 'ACCEPTED' }>('POST', '/auth/forgot-password', { body: { email } });
  }

  async resetPassword(input: { token: string; newPassword: string }): Promise<void> {
    await this.client.request<undefined>('POST', '/auth/reset-password', { body: input });
    this.client.clearCsrfToken();
  }

  requestAccountUnlock(email: string) {
    return this.client.request<{ status: 'ACCEPTED' }>('POST', '/auth/unlock/request', { body: { email } });
  }

  async unlockAccount(input: { email: string; code: string }): Promise<void> {
    await this.client.request<undefined>('POST', '/auth/unlock', { body: input });
  }

  totpSetup() {
    return this.client.request<{ otpauthUri: string; secret: string }>('POST', '/auth/totp/setup');
  }

  totpEnable(code: string) {
    return this.client.request<{ recoveryCodes: string[]; csrfToken: string }>('POST', '/auth/totp/enable', {
      body: { code },
    });
  }

  totpDisable(input: { password: string; totp?: string; recoveryCode?: string }) {
    return this.client.request<{ csrfToken: string }>('POST', '/auth/totp/disable', { body: input });
  }

  me() {
    return this.client.request<User>('GET', '/users/me');
  }

  updateMe(input: { locale?: string; timeZone?: string }) {
    return this.client.request<User>('PATCH', '/users/me', { body: input });
  }

  listSessions() {
    return this.client.request<{ sessions: AccountSession[] }>('GET', '/sessions');
  }

  async revokeSession(id: string): Promise<void> {
    await this.client.request<undefined>('DELETE', `/sessions/${enc(id)}`);
  }

  revokeOtherSessions() {
    return this.client.request<{ revoked: number }>('DELETE', '/sessions');
  }

  // --- PlatformSession ([B-PSES]) ---------------------------------------------------------------------------------

  opaqueStart(input: { startLoginRequest: string; sessionPublicKey: P256PublicJwk; walletId?: string }) {
    return this.client.request<{ loginAttemptId: string; loginResponse: string; expiresAt: string }>(
      'POST',
      '/platform-sessions/opaque/start',
      { body: input },
    );
  }

  opaqueFinish(input: { loginAttemptId: string; finishLoginRequest: string; sessionKeyBinding: string }) {
    return this.client.request<IssuedPlatformSession>('POST', '/platform-sessions/opaque/finish', { body: input });
  }

  stepUpStart(input: { scope: StepUpScope; sessionPublicKey: P256PublicJwk; walletId?: string }) {
    return this.client.request<{ challengeId: string; expiresAt: string; keyRestoreNonce?: `0x${string}` }>(
      'POST',
      '/platform-sessions/step-up/start',
      { body: input },
    );
  }

  stepUpFinish(input: StepUpFinishInput) {
    return this.client.request<IssuedPlatformSession & { csrfToken: string }>(
      'POST',
      '/platform-sessions/step-up/finish',
      { body: input },
    );
  }

  checkPlatformSession(platform: PlatformAuth) {
    return this.client.request<PlatformSessionView>('POST', '/platform-sessions/check', { platform });
  }

  async revokePlatformSession(id: string): Promise<void> {
    await this.client.request<undefined>('DELETE', `/platform-sessions/${enc(id)}`);
  }

  // --- Wallet y clave U ([B-WAL], [B-PSES-03]) --------------------------------------------------------------------

  myWallet() {
    return this.client.request<{ wallet: WalletView | null }>('GET', '/wallets/me');
  }

  createWallet(platform: PlatformAuth, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<WalletView>('POST', '/wallets', { platform, idempotencyKey });
  }

  userKeyOpaqueRegistration(platform: PlatformAuth, walletId: string, registrationRequest: string) {
    return this.client.request<{ registrationResponse: string; keyVersion: number }>(
      'POST',
      `/wallets/${enc(walletId)}/user-key/opaque-registration`,
      { platform, body: { registrationRequest } },
    );
  }

  registerUserKey(
    platform: PlatformAuth,
    walletId: string,
    input: UserKeyRegistration,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ userKey: Address; keyVersion: number; status: 'PENDING' }>(
      'POST',
      `/wallets/${enc(walletId)}/user-key`,
      { platform, body: input, idempotencyKey },
    );
  }

  restoreUserKey(
    platform: PlatformAuth,
    walletId: string,
    input: { registrationRecord: string; kdfParams: KdfParams; storageFlags: StorageFlags },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ userKey: Address; keyVersion: number; status: 'ACTIVE' }>(
      'POST',
      `/wallets/${enc(walletId)}/user-key/restore`,
      { platform, body: input, idempotencyKey },
    );
  }

  changeUserKeyPassword(
    platform: PlatformAuth,
    walletId: string,
    input: { registrationRecord: string; kdfParams: KdfParams; storageFlags: StorageFlags },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ userKey: Address; keyVersion: number; status: 'ACTIVE' }>(
      'POST',
      `/wallets/${enc(walletId)}/user-key/password`,
      { platform, body: input, idempotencyKey },
    );
  }

  registerReplacementUserKey(
    platform: PlatformAuth,
    input: UserKeyRegistration & { keyAcceptance: { nonce: `0x${string}`; signature: `0x${string}` } },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{
      rotationId: string;
      walletId: string;
      userKey: Address;
      keyVersion: number;
      status: 'DRAFT';
    }>('POST', '/recovery/u-replacement', { platform, body: input, idempotencyKey });
  }

  listRotations(walletId: string) {
    return this.client.request<{ items: Rotation[] }>('GET', `/wallets/${enc(walletId)}/rotations`);
  }
}
