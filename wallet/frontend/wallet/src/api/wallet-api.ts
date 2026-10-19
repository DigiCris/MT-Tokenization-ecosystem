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

/** Estado de la cooperación de la plataforma (P20.T03): PAUSED si una app no pasa el control de integridad. */
export interface PlatformStatus {
  integrity: 'MONITORED' | 'NOT_MONITORED';
  cooperation: 'ACTIVE' | 'DEGRADED' | 'PAUSED';
  apps: { app: 'WALLET' | 'RECOVERY'; status: 'OK' | 'MISMATCH' | 'UNREACHABLE' | null; releaseId: string | null }[];
}

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

export type RotationRole = 'U' | 'R' | 'S' | 'GUARD' | 'MODULE_GUARD';
export type ExecutorRotationReason = 'SHARD_MIGRATION' | 'HSM_MIGRATION' | 'KEY_COMPROMISE' | 'MAINTENANCE';

export interface CancelRotationTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: 'CancelRotation';
  message: { proposalId: `0x${string}`; safe: Address };
}

export interface Rotation {
  id: string;
  walletId: string;
  role: RotationRole;
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
  proposalId: `0x${string}` | null;
  executableAt: string | null;
  cancelledBy: 'U' | 'R' | 'SAFE' | null;
  proposeOperationId: string | null;
  executeOperationId: string | null;
  proposedAt: string | null;
  executedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  cancelTypedData: CancelRotationTypedData | null;
  /** Rotación de S pedida por la plataforma: motivo del borrador del operador. */
  requestReason: ExecutorRotationReason | null;
  /** Rotación de S: SignerKeyAttestation de la S nueva. */
  newKeyAttestation: string | null;
}

// --- Onboarding de la Safe ([B-WAL], P12) -------------------------------------------------------------------------

export interface RecoveryEnrollment {
  id: string;
  walletId: string;
  purpose: 'ONBOARDING' | 'REPLACEMENT';
  status: 'REQUESTED' | 'SUBMITTED' | 'CONFIRMED' | 'EXPIRED' | 'REJECTED' | 'RETIRED';
  expiresAt: string;
  enrollmentKeyRegistered: boolean;
  recoveryKey: Address | null;
  rType: 'INTERNAL' | 'EXTERNAL' | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  /** Sólo con REJECTED (ADR-033): SUPERSEDED o el motivo con el que la Wallet abortó el pedido. */
  rejectionReason?:
    'SUPERSEDED' | 'MANUAL_COMPARISON_FAILED' | 'RETURN_LINK_KEY_MISMATCH' | 'RETURN_LINK_UNVERIFIED' | null;
}

export interface CreatedEnrollment {
  enrollmentId: string;
  nonce: `0x${string}`;
  expiresAt: string;
  status: 'REQUESTED';
  purpose: 'ONBOARDING' | 'REPLACEMENT';
}

export interface WalletCreationAuthorizationMessage {
  userId: string;
  platformId: string;
  walletId: string;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  /** uint256 en decimal. */
  saltNonce: string;
  expectedSafe: Address;
  enrollmentNonce: `0x${string}`;
}

export interface ExecutorAssignment {
  walletId: string;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  shardId: string;
  /** SignerKeyAttestation de S (JWS EdDSA). */
  executorAttestation: string;
  saltNonce: string;
  expectedSafe: Address;
  configHash: `0x${string}`;
  enrollmentId: string;
  enrollmentNonce: `0x${string}`;
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, { name: string; type: string }[]>;
    /** Viene del backend: la app lo compara contra el propio. */
    primaryType: string;
    message: WalletCreationAuthorizationMessage;
  };
}

export interface DeploymentInfo {
  walletId: string;
  status: WalletStatus;
  U: Address | null;
  R: Address | null;
  S: Address | null;
  saltNonce: string | null;
  factory: Address;
  singleton: Address;
  proxyFactory: Address;
  bootstrap: Address;
  guard: Address;
  moduleGuard: Address;
  timelock: Address;
  policyRegistry: Address;
  whitelist: Address;
  swapExecutor: Address;
  expectedSafe: Address | null;
  configHash: `0x${string}` | null;
  deployTxHash: `0x${string}` | null;
  failureReason: string | null;
}

// --- Operaciones ([B-OPS], P13) -----------------------------------------------------------------------------------

export type TokenSymbol = 'USDC' | 'USDT';

export interface SafeTxJson {
  to: Address;
  /** uint256 en decimal. */
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
}

export type OperationType =
  | 'SEND'
  | 'SWAP_APPROVE'
  | 'SWAP'
  | 'WHITELIST_ADD'
  | 'WHITELIST_REMOVE'
  | 'ROTATION_PROPOSE'
  | 'ROTATION_EXECUTE'
  | 'NOOP_CANCEL'
  | 'MIGRATION_TRANSFER'
  | 'APPROVE_REVOKE'
  | 'GUARD_UPGRADE';

export interface DecodedOperation {
  token?: TokenSymbol;
  amount?: string;
  destination?: Address;
  tokenIn?: TokenSymbol;
  tokenOut?: TokenSymbol;
  minAmountOut?: string;
  deadline?: string;
  role?: RotationRole;
  oldKey?: Address;
  newKey?: Address;
}

export interface PreparedOperation {
  operationId: string;
  groupId: string | null;
  walletId: string;
  safe: Address;
  chainId: number;
  operationType: OperationType;
  safeTx: SafeTxJson;
  safeTxHash: `0x${string}`;
  typedData: unknown;
  decoded: DecodedOperation;
  requiresTwoFactor: boolean;
  /** Umbral de 2FA de la policy (unidades de 6 decimales) cuando la operación lo exige: sólo para el texto del review. */
  twoFactorThreshold?: string | null;
  expiresAt: string;
}

export type OperationState =
  | 'CREATED'
  | 'USER_SIGNED'
  | 'QUEUED'
  | 'VALIDATING'
  | 'READY'
  | 'SUBMITTED'
  | 'MINED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'REORGED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface OperationStatus {
  id: string;
  walletId: string;
  status: OperationState;
  operationType: OperationType;
  /** Intención guardada al preparar (monto, token, destino…): la actividad la muestra aunque no haya transfers. */
  decoded?: DecodedOperation;
  groupId: string | null;
  safeNonce: string | null;
  safeTxHash: `0x${string}` | null;
  txHash: `0x${string}` | null;
  blockNumber: string | null;
  blockHash: `0x${string}` | null;
  confirmations: { safe: number; finalized: boolean };
  failureReason: string | null;
  lastErrorCode: string | null;
  blockedReason: 'WAITING_LOWER_NONCE' | null;
  requiresTwoFactor: boolean;
  expiresAt: string | null;
  cancelsOperationId: string | null;
  createdAt: string;
  history: { status: OperationState; at: string }[];
}

export interface SignatureSubmission {
  ownerSignature: `0x${string}`;
  ownerRole: 'U';
  submissionEnvelope: { operationId: string; safeTxHash: `0x${string}`; sessionId: string; submittedAt: number };
  submissionEnvelopeSignature: string;
  twoFactorChallengeId?: string;
}

export interface Balances {
  walletId: string;
  safe: Address;
  chainId: number;
  blockNumber: string;
  tokens: {
    symbol: TokenSymbol;
    address: Address;
    decimals: 6;
    balance: string;
    allowanceToSwapExecutor: string;
  }[];
}

export interface Transfer {
  id: string;
  token: TokenSymbol;
  tokenAddress: Address;
  direction: 'IN' | 'OUT';
  counterparty: Address;
  amount: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: string;
  status: 'MINED' | 'CONFIRMED' | 'FINALIZED';
  createdAt: string;
}

export interface SwapQuote {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  priceImpactBps: number;
  deadline: string;
  blockNumber: string;
  quotedAt: string;
  pool: Address;
  fee: number;
}

export interface OperationGroup {
  id: string;
  walletId: string;
  type: 'SWAP';
  status: 'OPEN' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  quote: Omit<SwapQuote, 'tokenIn' | 'tokenOut' | 'amountIn' | 'pool' | 'fee'>;
  failureReason: string | null;
  completedAt: string | null;
  createdAt: string;
  nextActions: ('REQUOTE' | 'REVOKE_APPROVAL')[];
  operations: OperationStatus[];
}

export interface WhitelistEntry {
  id: string;
  destination: Address;
  label: string;
  status: 'ACTIVATING' | 'ACTIVE' | 'REMOVED';
  activatesAt: string | null;
  activatedAt: string | null;
  origin: 'PLATFORM' | 'SOVEREIGN';
  addedTxHash: `0x${string}` | null;
}

export interface WhitelistRequest {
  id: string;
  walletId: string;
  destination: Address;
  label: string;
  status:
    | 'PENDING_CHALLENGE'
    | 'CHALLENGE_PASSED'
    | 'AWAITING_SIGNATURE'
    | 'SUBMITTED'
    | 'ACTIVATING'
    | 'ACTIVE'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'FAILED';
  challengeExpiresAt: string | null;
  operationId: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface MigrationPreparation {
  case: {
    id: string;
    oldWalletId: string;
    newWalletId: string | null;
    healthyRole: 'U' | 'R';
    reason: string;
    status: 'REQUESTED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED';
    createdAt: string;
    completedAt: string | null;
  };
  destination: { walletId: string; safe: Address };
  operations: PreparedOperation[];
}

export interface AppNotification {
  id: string;
  walletId: string | null;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
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

  /** Estado público de la cooperación (pausa por integridad de los frontends, P20.T03). */
  async platformStatus(): Promise<PlatformStatus> {
    return this.client.request<PlatformStatus>('GET', '/platform/status');
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

  async opaqueFinish(input: { loginAttemptId: string; finishLoginRequest: string; sessionKeyBinding: string }) {
    const issued = await this.client.request<IssuedPlatformSession>('POST', '/platform-sessions/opaque/finish', {
      body: input,
    });
    this.client.observeServerTime(issued.session.issuedAt);
    return issued;
  }

  stepUpStart(input: { scope: StepUpScope; sessionPublicKey: P256PublicJwk; walletId?: string }) {
    return this.client.request<{ challengeId: string; expiresAt: string; keyRestoreNonce?: `0x${string}` }>(
      'POST',
      '/platform-sessions/step-up/start',
      { body: input },
    );
  }

  async stepUpFinish(input: StepUpFinishInput) {
    const issued = await this.client.request<IssuedPlatformSession & { csrfToken: string }>(
      'POST',
      '/platform-sessions/step-up/finish',
      { body: input },
    );
    this.client.observeServerTime(issued.session.issuedAt);
    return issued;
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

  // --- Recovery y Safe (P12, P18.T01/T02) -------------------------------------------------------------------------

  createRecoveryEnrollment(platform: PlatformAuth, walletId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<CreatedEnrollment>('POST', `/wallets/${enc(walletId)}/recovery/enrollments`, {
      platform,
      idempotencyKey,
    });
  }

  getRecoveryEnrollment(enrollmentId: string) {
    return this.client.request<RecoveryEnrollment>('GET', `/recovery/enrollments/${enc(enrollmentId)}`);
  }

  assignExecutor(platform: PlatformAuth, walletId: string) {
    return this.client.request<ExecutorAssignment>('POST', `/wallets/${enc(walletId)}/executor`, { platform });
  }

  incorporateRecoveryKey(
    platform: PlatformAuth,
    enrollmentId: string,
    input: { authorization: WalletCreationAuthorizationMessage; signature: `0x${string}` },
  ) {
    return this.client.request<RecoveryEnrollment>('POST', `/recovery/enrollments/${enc(enrollmentId)}/incorporate`, {
      platform,
      body: input,
    });
  }

  deployWallet(platform: PlatformAuth, walletId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<WalletView>('POST', `/wallets/${enc(walletId)}/deploy`, { platform, idempotencyKey });
  }

  walletDeployment(walletId: string) {
    return this.client.request<DeploymentInfo>('GET', `/wallets/${enc(walletId)}/deployment`);
  }

  // --- Saldos, actividad y notificaciones (P18.T03/T08) -----------------------------------------------------------

  balances(walletId: string) {
    return this.client.request<Balances>('GET', `/wallets/${enc(walletId)}/balances`);
  }

  transfers(walletId: string, page: { limit?: number; before?: string } = {}) {
    return this.client.request<{ items: Transfer[]; nextCursor: string | null }>(
      'GET',
      `/wallets/${enc(walletId)}/transfers${query(page)}`,
    );
  }

  operations(walletId: string, page: { limit?: number; before?: string } = {}) {
    return this.client.request<{ items: OperationStatus[]; nextCursor: string | null }>(
      'GET',
      `/wallets/${enc(walletId)}/operations${query(page)}`,
    );
  }

  operation(operationId: string) {
    return this.client.request<OperationStatus>('GET', `/operations/${enc(operationId)}`);
  }

  notifications(page: { limit?: number; before?: string; unread?: boolean } = {}) {
    return this.client.request<{ items: AppNotification[]; unread: number; nextCursor: string | null }>(
      'GET',
      `/notifications${query(page)}`,
    );
  }

  markNotificationRead(id: string) {
    return this.client.request<AppNotification>('POST', `/notifications/${enc(id)}/read`, { body: {} });
  }

  // --- Firma y envío de operaciones (A.1) -------------------------------------------------------------------------

  submitOperationSignature(
    platform: PlatformAuth,
    operationId: string,
    input: SignatureSubmission,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<OperationStatus>('POST', `/operations/${enc(operationId)}/signatures`, {
      platform,
      body: input,
      idempotencyKey,
    });
  }

  cancelOperation(platform: PlatformAuth, operationId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<{ operation: OperationStatus; noop: PreparedOperation | null }>(
      'POST',
      `/operations/${enc(operationId)}/cancel`,
      { platform, idempotencyKey },
    );
  }

  requestOperationTwoFactor(platform: PlatformAuth, operationId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<{ method: 'TOTP' | 'EMAIL'; challengeId: string; expiresAt: string }>(
      'POST',
      `/operations/${enc(operationId)}/two-factor`,
      { platform, body: {}, idempotencyKey },
    );
  }

  confirmOperationTwoFactor(
    platform: PlatformAuth,
    operationId: string,
    code: string,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<OperationStatus>('POST', `/operations/${enc(operationId)}/two-factor`, {
      platform,
      body: { code },
      idempotencyKey,
    });
  }

  // --- Send, swap y whitelist (P14, P18.T05–T07) ------------------------------------------------------------------

  prepareSend(
    platform: PlatformAuth,
    walletId: string,
    input: { token: TokenSymbol; destination: Address; amount: string },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<PreparedOperation>('POST', `/wallets/${enc(walletId)}/send/prepare`, {
      platform,
      body: input,
      idempotencyKey,
    });
  }

  swapQuote(walletId: string, input: { tokenIn: TokenSymbol; amountIn: string; slippageBps?: number }) {
    return this.client.request<SwapQuote>('GET', `/wallets/${enc(walletId)}/swap/quote${query(input)}`);
  }

  prepareSwap(
    platform: PlatformAuth,
    walletId: string,
    input: { tokenIn: TokenSymbol; amountIn: string; slippageBps?: number },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ group: OperationGroup; quote: SwapQuote; operations: PreparedOperation[] }>(
      'POST',
      `/wallets/${enc(walletId)}/swap/prepare`,
      { platform, body: input, idempotencyKey },
    );
  }

  operationGroup(groupId: string) {
    return this.client.request<OperationGroup>('GET', `/operation-groups/${enc(groupId)}`);
  }

  requoteSwap(
    platform: PlatformAuth,
    groupId: string,
    input: { slippageBps?: number } = {},
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ group: OperationGroup; quote: SwapQuote; operations: PreparedOperation[] }>(
      'POST',
      `/operation-groups/${enc(groupId)}/requote`,
      { platform, body: input, idempotencyKey },
    );
  }

  revokeSwapApproval(platform: PlatformAuth, groupId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<PreparedOperation>('POST', `/operation-groups/${enc(groupId)}/revoke-approval`, {
      platform,
      idempotencyKey,
    });
  }

  whitelist(walletId: string) {
    return this.client.request<{ entries: WhitelistEntry[]; requests: WhitelistRequest[] }>(
      'GET',
      `/wallets/${enc(walletId)}/whitelist`,
    );
  }

  requestWhitelistDestination(
    platform: PlatformAuth,
    walletId: string,
    input: { destination: Address; label: string },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<WhitelistRequest>('POST', `/wallets/${enc(walletId)}/whitelist/requests`, {
      platform,
      body: input,
      idempotencyKey,
    });
  }

  confirmWhitelistRequest(
    platform: PlatformAuth,
    requestId: string,
    code: string,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<{ request: WhitelistRequest; operation: PreparedOperation }>(
      'POST',
      `/whitelist/requests/${enc(requestId)}/confirm`,
      { platform, body: { code }, idempotencyKey },
    );
  }

  removeWhitelistDestination(
    platform: PlatformAuth,
    walletId: string,
    destination: Address,
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<PreparedOperation>(
      'POST',
      `/wallets/${enc(walletId)}/whitelist/${enc(destination)}/remove`,
      { platform, idempotencyKey },
    );
  }

  // --- Rotaciones y migración (P15, P18.T09–T11) ------------------------------------------------------------------

  proposeRotation(platform: PlatformAuth, walletId: string, role: RotationRole, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<{ rotation: Rotation; operation: PreparedOperation }>(
      'POST',
      `/wallets/${enc(walletId)}/rotations`,
      { platform, body: { role }, idempotencyKey },
    );
  }

  prepareRotationExecution(platform: PlatformAuth, rotationId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<{ rotation: Rotation; operation: PreparedOperation }>(
      'POST',
      `/rotations/${enc(rotationId)}/execute/prepare`,
      { platform, idempotencyKey },
    );
  }

  /** Relay público de la cancelación: la autoriza la firma EIP-712 `CancelRotation` de U. */
  relayRotationCancellation(rotationId: string, signature: `0x${string}`) {
    return this.client.request<{
      rotation: Rotation;
      relay: { status: 'REQUESTED'; signer: Address; role: 'U' | 'R' };
    }>('POST', `/rotations/${enc(rotationId)}/cancel`, { body: { signature } });
  }

  prepareMigration(platform: PlatformAuth, oldWalletId: string, idempotencyKey = newIdempotencyKey()) {
    return this.client.request<MigrationPreparation>('POST', `/wallets/${enc(oldWalletId)}/migration/prepare`, {
      platform,
      idempotencyKey,
    });
  }
}

/** Query string de los parámetros definidos (orden estable). */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  );
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}
