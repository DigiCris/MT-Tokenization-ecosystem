// Endpoints del listener de Recovery (P12/P15) que usa la app: cuenta, step-up (PlatformSession ENROLLMENT/RECOVERY con
// la session key propia), enrollment de R, rotaciones (U, S y la cancelación por relay), operaciones firmadas por R,
// emergencia, migración y notificaciones. Los tipos siguen las respuestas del backend; lo que se firma la app lo
// reconstruye por su cuenta (nada de una SafeTx se toma del backend sin verificarlo).
import type { Address, Hex } from 'viem';
import { newIdempotencyKey, type ApiClient, type PlatformAuth } from './client.ts';
import type { P256PublicJwk } from './session-key.ts';
import type { SubmissionEnvelope } from './submission.ts';

export type TokenSymbol = 'USDC' | 'USDT';
export type RotationRole = 'U' | 'R' | 'S' | 'GUARD' | 'MODULE_GUARD';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  locale: string;
  timeZone: string;
  createdAt: string;
}

export type StepUpScope = 'ENROLLMENT' | 'RECOVERY';

export interface PlatformSessionView {
  id: string;
  scope: StepUpScope;
  authMethod: 'STEP_UP';
  walletId: string | null;
  safe: Address | null;
  issuedAt: string;
  expiresAt: string;
}

export interface EnrollmentStatus {
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
  /**
   * Sólo con REJECTED: SUPERSEDED (la Wallet pidió otro) o por qué lo canceló la Wallet ([F-LNK-02]). Un backend
   * anterior no lo manda.
   */
  rejectionReason?:
    'SUPERSEDED' | 'MANUAL_COMPARISON_FAILED' | 'RETURN_LINK_KEY_MISMATCH' | 'RETURN_LINK_UNVERIFIED' | null;
}

export interface EnrollmentObject {
  userId: string;
  platformId: string;
  R: Address;
  nonce: Hex;
  issuedAt: string;
  expiresAt: string;
}

export interface StorageFlags {
  drive: boolean;
  file: boolean;
  qr: boolean;
  words: boolean;
}

export interface EnrollmentSubmission {
  enrollment: EnrollmentObject;
  enrollmentKeySignature: string;
  rType: 'INTERNAL' | 'EXTERNAL';
  connectorId?: string;
  proofOfControl: Hex;
  storageFlags?: StorageFlags;
  keyAcceptance?: { nonce: Hex; signature: Hex };
}

export interface SafeTxJson {
  to: Address;
  value: string;
  data: Hex;
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
  | 'APPROVE_REVOKE'
  | 'WHITELIST_ADD'
  | 'WHITELIST_REMOVE'
  | 'ROTATION_PROPOSE'
  | 'ROTATION_EXECUTE'
  | 'NOOP_CANCEL'
  | 'MIGRATION_TRANSFER'
  | 'GUARD_UPGRADE';

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

export interface PreparedOperation {
  operationId: string;
  groupId: string | null;
  walletId: string;
  safe: Address;
  chainId: number;
  operationType: OperationType;
  safeTx: SafeTxJson;
  safeTxHash: Hex;
  typedData: Record<string, unknown>;
  decoded: Record<string, string | undefined>;
  requiresTwoFactor: boolean;
  expiresAt: string;
}

export interface OperationStatus {
  id: string;
  walletId: string;
  status: OperationState;
  operationType: OperationType;
  groupId: string | null;
  safeNonce: string;
  safeTxHash: Hex;
  txHash: Hex | null;
  blockNumber: string | null;
  failureReason: string | null;
  lastErrorCode: string | null;
  blockedReason: 'WAITING_LOWER_NONCE' | null;
  createdAt: string;
}

export type RotationStatus =
  | 'DRAFT'
  | 'AWAITING_SIGNATURE'
  | 'PROPOSING'
  | 'PENDING_TIMELOCK'
  | 'READY_TO_EXECUTE'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'CANCELLED'
  | 'FAILED';

export interface Rotation {
  id: string;
  walletId: string;
  role: RotationRole;
  oldKey: Address;
  newKey: Address;
  status: RotationStatus;
  origin: 'PLATFORM' | 'ONCHAIN';
  initiatedBy: 'U' | 'R' | 'SAFE';
  proposalId: Hex | null;
  executableAt: string | null;
  cancelledBy: string | null;
  proposeOperationId: string | null;
  executeOperationId: string | null;
  proposedAt: string | null;
  executedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  cancelTypedData: Record<string, unknown> | null;
  requestReason: string | null;
  newKeyAttestation: string | null;
}

export interface WhitelistEntry {
  id: string;
  destination: Address;
  label: string | null;
  status: 'ACTIVATING' | 'ACTIVE' | 'REMOVED';
  activatesAt: string | null;
  activatedAt: string | null;
  origin: 'PLATFORM' | 'SOVEREIGN';
}

export interface AppNotification {
  id: string;
  walletId: string | null;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface MigrationCase {
  id: string;
  oldWalletId: string;
  newWalletId: string | null;
  healthyRole: 'U' | 'R';
  reason: string;
  status: string;
}

export interface MigrationPreparation {
  case: MigrationCase;
  destination: { walletId: string; safe: Address };
  operations: PreparedOperation[];
}

const enc = encodeURIComponent;

export class RecoveryApi {
  readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  // --- Cuenta -------------------------------------------------------------------------------------------------------

  login(input: { email: string; password: string; totp?: string; recoveryCode?: string }) {
    return this.client.request<{ user: User; csrfToken: string }>('POST', '/auth/login', { body: input });
  }

  logout() {
    return this.client.request<unknown>('POST', '/auth/logout');
  }

  me() {
    return this.client.request<User>('GET', '/users/me');
  }

  // --- Step-up y PlatformSession -------------------------------------------------------------------------------------

  startStepUp(input: { scope: StepUpScope; sessionPublicKey: P256PublicJwk; walletId?: string }) {
    return this.client.request<{ challengeId: string; expiresAt: string }>('POST', '/platform-sessions/step-up/start', {
      body: input,
    });
  }

  finishStepUp(input: { challengeId: string; code: string; totp?: string; recoveryCode?: string }) {
    return this.client.request<{ token: string; session: PlatformSessionView; csrfToken: string }>(
      'POST',
      '/platform-sessions/step-up/finish',
      { body: input },
    );
  }

  checkPlatformSession(platform: PlatformAuth) {
    return this.client.request<{ session: PlatformSessionView }>('POST', '/platform-sessions/check', { platform });
  }

  revokePlatformSession(sessionId: string) {
    return this.client.request<unknown>('DELETE', `/platform-sessions/${enc(sessionId)}`);
  }

  // --- Enrollment de R ------------------------------------------------------------------------------------------------

  enrollment(enrollmentId: string) {
    return this.client.request<EnrollmentStatus>('GET', `/recovery/enrollments/${enc(enrollmentId)}`);
  }

  registerEnrollmentKey(platform: PlatformAuth, enrollmentId: string, enrollmentKey: P256PublicJwk) {
    return this.client.request<EnrollmentStatus>('POST', `/recovery/enrollments/${enc(enrollmentId)}/enrollment-key`, {
      platform,
      body: { enrollmentKey },
    });
  }

  submitEnrollment(platform: PlatformAuth, enrollmentId: string, submission: EnrollmentSubmission) {
    return this.client.request<EnrollmentStatus>('POST', `/recovery/enrollments/${enc(enrollmentId)}/submit`, {
      platform,
      body: submission,
    });
  }

  // --- Rotaciones ----------------------------------------------------------------------------------------------------

  rotations(walletId: string) {
    return this.client.request<{ items: Rotation[] }>('GET', `/wallets/${enc(walletId)}/rotations`);
  }

  proposeRotation(platform: PlatformAuth, walletId: string, role: 'U' | 'S', idempotencyKey = newIdempotencyKey()) {
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

  relayRotationCancellation(rotationId: string, signature: Hex) {
    return this.client.request<{ rotation: Rotation; relay: { status: string; signer: Address; role: 'U' | 'R' } }>(
      'POST',
      `/rotations/${enc(rotationId)}/cancel`,
      { body: { signature } },
    );
  }

  // --- Operaciones ---------------------------------------------------------------------------------------------------

  operations(walletId: string, page: { limit?: number; before?: string } = {}) {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set('limit', String(page.limit));
    if (page.before !== undefined) query.set('before', page.before);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.client.request<{ items: OperationStatus[]; nextCursor: string | null }>(
      'GET',
      `/wallets/${enc(walletId)}/operations${suffix}`,
    );
  }

  operation(operationId: string) {
    return this.client.request<OperationStatus>('GET', `/operations/${enc(operationId)}`);
  }

  submitSignature(
    platform: PlatformAuth,
    operationId: string,
    input: {
      ownerSignature: Hex;
      submissionEnvelope: SubmissionEnvelope;
      submissionEnvelopeSignature: string;
    },
    idempotencyKey = newIdempotencyKey(),
  ) {
    return this.client.request<OperationStatus>('POST', `/operations/${enc(operationId)}/signatures`, {
      platform,
      body: { ...input, ownerRole: 'R' },
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

  // --- Whitelist y emergencia ----------------------------------------------------------------------------------------

  whitelist(walletId: string) {
    return this.client.request<{ entries: WhitelistEntry[] }>('GET', `/wallets/${enc(walletId)}/whitelist`);
  }

  emergencyWhitelistRemove(platform: PlatformAuth, walletId: string, destination: Address) {
    return this.client.request<PreparedOperation>('POST', `/wallets/${enc(walletId)}/emergency/whitelist-remove`, {
      platform,
      body: { destination },
      idempotencyKey: newIdempotencyKey(),
    });
  }

  emergencyNoop(platform: PlatformAuth, walletId: string, operationId: string) {
    return this.client.request<{ operation: OperationStatus; noop: PreparedOperation | null }>(
      'POST',
      `/wallets/${enc(walletId)}/emergency/noop`,
      { platform, body: { operationId }, idempotencyKey: newIdempotencyKey() },
    );
  }

  emergencyRevokeApproval(platform: PlatformAuth, walletId: string, token: TokenSymbol) {
    return this.client.request<PreparedOperation>('POST', `/wallets/${enc(walletId)}/emergency/revoke-approval`, {
      platform,
      body: { token },
      idempotencyKey: newIdempotencyKey(),
    });
  }

  // --- Migración y notificaciones ------------------------------------------------------------------------------------

  prepareMigration(platform: PlatformAuth, walletId: string) {
    return this.client.request<MigrationPreparation>('POST', `/wallets/${enc(walletId)}/migration/prepare`, {
      platform,
      idempotencyKey: newIdempotencyKey(),
    });
  }

  notifications(options: { limit?: number; unread?: boolean } = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.unread !== undefined) query.set('unread', String(options.unread));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.client.request<{ items: AppNotification[]; unread: number; nextCursor: string | null }>(
      'GET',
      `/notifications${suffix}`,
    );
  }
}
