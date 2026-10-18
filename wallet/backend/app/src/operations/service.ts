// Servicio de operaciones (P13.T02/T03/T08): `prepare` interno (lo usan los flujos de send, swap, whitelist,
// rotaciones y cancelación), el envío de la firma U/R (POST /operations/{id}/signatures), la cancelación (NoOp con el
// mismo nonce, [B-NONCE-06]), las lecturas con historial y el vencimiento de operaciones sin firma o con firma vieja.
//
// Las lecturas on-chain (quórum) se hacen FUERA de las transacciones (withTransaction puede reintentar el cuerpo); la
// transacción vuelve a exigir el estado esperado (transición desde CREATED, lock de la wallet) antes de escribir.
import { sql, type Kysely, type Transaction } from 'kysely';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { safeConfigDrift } from '../chain/safe-state.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { Database, OperationStatus } from '../db/schema.ts';
import { sqlState, withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress, bufferToHex, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { submissionProblem, type SubmissionEnvelope } from '../platform-session/request-signature.ts';
import type { VerifiedPlatformSession } from '../platform-session/sessions.ts';
import { decodeOperation, evaluatePolicy, type PolicyFacts } from '../policy/evaluate.ts';
import type { BackendPolicySnapshot, OperationKind } from '../policy/snapshot.ts';
import type { SovereignModification } from '../wallets/sovereign.ts';
import { challengeFacts } from './challenges.ts';
import { decodeRevertReason, policyFactsFrom, readOperationContext } from './chain-context.ts';
import {
  decodedView,
  safeTxFromJson,
  safeTxToJson,
  safeTxTypedDataJson,
  type CanonicalIntent,
  type OperationView,
  type PreparedOperation,
} from './intent.ts';
import { dailyOutflow } from './ledger.ts';
import { allocateNonce, lockWallet, refreshNextNonce } from './nonce-manager.ts';
import {
  OPERATION_STATUSES,
  TransitionConflictError,
  type OperationStateMachine,
  type TransitionResult,
} from './state-machine.ts';

/** Vida de una operación sin firma ([B-SM]: CREATED → EXPIRED a los 15 min). */
export const OPERATION_TTL_MS = 15 * 60_000;
/** Tolerancia del `submittedAt` del envelope respecto del reloj del servidor. */
export const SUBMISSION_SKEW_SECONDS = 60;
/** Antigüedad máxima de una firma desde su envío ([B-PSES-06]). */
export const SIGNATURE_MAX_AGE_SECONDS = 24 * 3600;

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const CANCELLABLE: readonly OperationStatus[] = [
  'USER_SIGNED',
  'QUEUED',
  'READY',
  'SUBMITTED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
];

export interface OperationActor {
  userId: string;
  session: VerifiedPlatformSession;
  meta: { requestId: string; ipPrefix: string | null };
}

export interface PrepareInput {
  walletId: string;
  operationType: OperationKind;
  call: { to: Address; value?: bigint; data: Hex };
  groupId?: string | null;
  /** Hechos ya verificados por el flujo que prepara (challenge de whitelist, SWAP emparejado, KeyAcceptance…). */
  extraFacts?: Partial<PolicyFacts>;
}

export interface SubmitSignatureInput {
  ownerSignature: Hex;
  ownerRole: 'U' | 'R';
  submissionEnvelope: SubmissionEnvelope;
  submissionEnvelopeSignature: string;
}

export interface OperationServiceDeps {
  db: Kysely<Database>;
  machine: OperationStateMachine;
  audit: AuditWriter;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  sovereign: SovereignModification;
  logger: Logger;
  metrics?: Metrics;
  /** Reloj en ms (tests). */
  now?: () => number;
}

type OperationRow = Awaited<ReturnType<typeof selectOperation>>;

function selectOperation(db: Kysely<Database> | Transaction<Database>, id: string) {
  return db.selectFrom('wallet_operations').selectAll().where('id', '=', id).executeTakeFirst();
}

export function roleForScope(scope: string): 'U' | 'R' {
  if (scope === 'OPERATIONS') return 'U';
  if (scope === 'RECOVERY') return 'R';
  throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'sólo OPERATIONS (U) o RECOVERY (R) firman operaciones' });
}

function buildSafeTx(call: PrepareInput['call'], nonce: bigint): SafeTx {
  return {
    to: call.to,
    value: call.value ?? 0n,
    data: call.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class OperationService {
  readonly #d: OperationServiceDeps;

  constructor(deps: OperationServiceDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** Wallet del actor, ACTIVE y atada a la PlatformSession ([B-AUTHZ]: de otro usuario → 404). */
  async #walletFor(actor: OperationActor, walletId: string) {
    if (!isUuid(walletId)) throw new ApiError('NOT_FOUND');
    const wallet = await this.#d.db
      .selectFrom('wallets')
      .select(['id', 'user_id', 'status', 'safe_address', 'chain_id'])
      .where('id', '=', walletId)
      .executeTakeFirst();
    if (wallet?.user_id !== actor.userId) throw new ApiError('NOT_FOUND');
    if (actor.session.claims.walletId !== wallet.id) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
    }
    if (wallet.status === 'SOVEREIGN_MODIFIED') throw new ApiError('SAFE_CONFIG_MODIFIED');
    if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
    const safe = bufferToAddress(wallet.safe_address);
    const claimed = actor.session.claims.safe;
    if (claimed === null || !isAddressEqual(claimed, safe)) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra Safe' });
    }
    return { id: wallet.id, safe, chainId: wallet.chain_id };
  }

  async #operationFor(userId: string, operationId: string): Promise<NonNullable<OperationRow>> {
    if (!isUuid(operationId)) throw new ApiError('NOT_FOUND');
    const op = await selectOperation(this.#d.db, operationId);
    if (op?.user_id !== userId) throw new ApiError('NOT_FOUND');
    return op;
  }

  /** Lecturas on-chain + policy de una SafeTx; la deriva de configuración marca la wallet y corta. */
  async #evaluate(input: {
    walletId: string;
    safe: Address;
    safeTx: SafeTx;
    call: DecodedCall;
    role: 'U' | 'R';
    scope: string;
    declaredType: OperationKind;
    precheck: boolean;
    excludeOperationId: string | null;
    extraFacts?: Partial<PolicyFacts>;
  }) {
    const snapshot = this.#d.snapshot();
    const { value: ctx } = await readOperationContext(this.#d.rpc, snapshot, {
      safe: input.safe,
      safeTx: input.safeTx,
      call: input.call,
      ownerRole: input.role,
      precheck: input.precheck,
    });
    const drift = safeConfigDrift(ctx.state, snapshot);
    if (drift.length > 0) {
      await withTransaction(
        this.#d.db,
        (trx) =>
          this.#d.sovereign.mark(trx, { walletId: input.walletId, safe: input.safe, items: drift, detectedBy: 'api' }),
        { auditLock: true },
      );
      throw new ApiError('SAFE_CONFIG_MODIFIED', { detail: drift.join(',') });
    }
    const facts = policyFactsFrom(ctx);
    facts.dailyOutflowUsed = await dailyOutflow(this.#d.db, {
      walletId: input.walletId,
      nonce: input.safeTx.nonce,
      excludeOperationId: input.excludeOperationId,
      amount: input.call.kind === 'ERC20_TRANSFER' ? input.call.amount : 0n,
    });
    const verdict = evaluatePolicy(snapshot, {
      safe: input.safe,
      role: input.role,
      scope: input.scope as 'OPERATIONS',
      declaredType: input.declaredType,
      safeTx: input.safeTx,
      facts: { ...facts, ...input.extraFacts },
    });
    return { ctx, verdict, snapshot };
  }

  /** Prepara una operación CREATED con nonce asignado [B-NONCE-01]; la firma U/R llega después. */
  async prepare(actor: OperationActor, input: PrepareInput): Promise<PreparedOperation> {
    const role = roleForScope(actor.session.claims.scope);
    const wallet = await this.#walletFor(actor, input.walletId);
    return this.#prepareFor(actor, wallet, role, input, null);
  }

  async #prepareFor(
    actor: OperationActor,
    wallet: { id: string; safe: Address; chainId: number },
    role: 'U' | 'R',
    input: PrepareInput,
    cancels: { operationId: string; nonce: bigint } | null,
  ): Promise<PreparedOperation> {
    const snapshot = this.#d.snapshot();
    const provisional = buildSafeTx(input.call, cancels?.nonce ?? 0n);
    const call = decodeOperation(snapshot, wallet.safe, provisional);
    if (call === null) throw new ApiError('POLICY_REJECTED', { detail: 'UNKNOWN_OPERATION' });
    const twoFactor =
      input.operationType === 'SEND' &&
      call.kind === 'ERC20_TRANSFER' &&
      call.amount >= snapshot.limits.twoFactorThreshold;
    // El SWAP N+1 se prepara antes de que se ejecute su approve: el pre-check del Guard lo hace el worker.
    const precheck = input.operationType !== 'SWAP';
    const { ctx, verdict } = await this.#evaluate({
      walletId: wallet.id,
      safe: wallet.safe,
      safeTx: provisional,
      call,
      role,
      scope: actor.session.claims.scope,
      declaredType: input.operationType,
      precheck,
      excludeOperationId: null,
      // El 2FA se completa después de preparar (el challenge se liga al SafeTxHash): acá se evalúa el resto.
      extraFacts: { ...input.extraFacts, ...(twoFactor ? { twoFactorVerified: true } : {}) },
    });
    if (verdict.verdict === 'REJECT') throw new ApiError('POLICY_REJECTED', { detail: verdict.code });
    if (ctx.precheck && !ctx.precheck.guardOk) {
      throw new ApiError('GUARD_WOULD_REVERT', { detail: decodeRevertReason(ctx.precheck.guardReason) });
    }
    if (ctx.precheck && !ctx.precheck.callOk) {
      throw new ApiError('GUARD_WOULD_REVERT', {
        detail: `la llamada revertiría (${decodeRevertReason(ctx.precheck.callRevert)})`,
      });
    }
    const onchainNonce = BigInt(ctx.state.nonce);
    if (cancels && cancels.nonce < onchainNonce) throw new ApiError('NONCE_CONSUMED');
    const expiresAt = new Date(this.#now() + OPERATION_TTL_MS);

    const prepared = await withTransaction(
      this.#d.db,
      async (trx) => {
        const locked = await lockWallet(trx, wallet.id);
        if (locked.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE');
        await this.#expireStaleIn(trx, wallet.id);
        const nonce = cancels ? cancels.nonce : await allocateNonce(trx, wallet.id, onchainNonce);
        const safeTx = buildSafeTx(input.call, nonce);
        const hash = safeTxHash(snapshot.chainId, wallet.safe, safeTx);
        const intent: CanonicalIntent = {
          version: 1,
          chainId: snapshot.chainId,
          safe: wallet.safe,
          operationType: input.operationType,
          ownerRole: role,
          safeTx: safeTxToJson(safeTx),
          decoded: decodedView(call),
        };
        const row = await trx
          .insertInto('wallet_operations')
          .values({
            user_id: actor.userId,
            wallet_id: wallet.id,
            safe_address: addressToBuffer(wallet.safe),
            chain_id: snapshot.chainId,
            safe_nonce: nonce.toString(),
            operation_type: input.operationType,
            group_id: input.groupId ?? null,
            safe_tx_hash: hexToBuffer(hash, 32),
            target: addressToBuffer(safeTx.to),
            value: safeTx.value.toString(),
            calldata: hexToBuffer(safeTx.data),
            canonical_intent: JSON.stringify(intent),
            status: 'CREATED',
            expires_at: expiresAt,
            requires_two_factor: twoFactor,
            policy_snapshot_version: snapshot.version,
            cancels_operation_id: cancels?.operationId ?? null,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: wallet.id,
          sessionId: actor.session.claims.sessionId,
          eventType: 'OPERATION_PROPOSED',
          targetType: 'operation',
          targetId: row.id,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: {
            type: input.operationType,
            nonce: nonce.toString(),
            safeTxHash: hash,
            decoded: intent.decoded,
            ...(cancels ? { cancels: cancels.operationId } : {}),
          },
        });
        return { id: row.id, intent, hash };
      },
      { auditLock: true },
    );
    this.#d.metrics?.operationTransitions.inc({ to: 'CREATED' });
    return {
      operationId: prepared.id,
      groupId: input.groupId ?? null,
      walletId: wallet.id,
      safe: wallet.safe,
      chainId: snapshot.chainId,
      operationType: input.operationType,
      safeTx: prepared.intent.safeTx,
      safeTxHash: prepared.hash,
      typedData: safeTxTypedDataJson(snapshot.chainId, wallet.safe, prepared.intent.safeTx),
      decoded: prepared.intent.decoded,
      requiresTwoFactor: twoFactor,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** CREATED vencidas de la wallet → EXPIRED (con la fila de la wallet bloqueada). */
  async #expireStaleIn(trx: Transaction<Database>, walletId: string): Promise<number> {
    const stale = await trx
      .selectFrom('wallet_operations')
      .select('id')
      .where('wallet_id', '=', walletId)
      .where('status', '=', 'CREATED')
      .where('expires_at', '<=', new Date(this.#now()))
      .execute();
    for (const op of stale) {
      await this.#d.machine.transitionIn(trx, {
        operationId: op.id,
        from: ['CREATED'],
        to: 'EXPIRED',
        actor: { type: 'SYSTEM', id: 'operation-expiry' },
        patch: { failure_reason: 'NOT_SIGNED_IN_TIME' },
      });
    }
    if (stale.length > 0) await refreshNextNonce(trx, walletId);
    return stale.length;
  }

  /** POST /operations/{id}/signatures [B-PSES-06], P13.T03: CREATED → USER_SIGNED → QUEUED (+ outbox). */
  async submitSignature(
    actor: OperationActor,
    operationId: string,
    input: SubmitSignatureInput,
  ): Promise<OperationView> {
    const op = await this.#operationFor(actor.userId, operationId);
    const claims = actor.session.claims;
    const snapshot = this.#d.snapshot();
    const intent = op.canonical_intent as CanonicalIntent;
    const signature = input.ownerSignature.toLowerCase() as Hex;
    // Reenvío de la misma firma (p. ej. reintento del cliente sin Idempotency-Key): devuelve el estado actual.
    if (op.status !== 'CREATED') {
      if (op.owner_signature !== null && bufferToHex(op.owner_signature) === signature)
        return this.get(actor.userId, op.id);
      throw new ApiError('OPERATION_NOT_PENDING', { detail: `la operación está en ${op.status}` });
    }
    const role = roleForScope(claims.scope);
    if (input.ownerRole !== role || intent.ownerRole !== role) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: `la operación la firma ${intent.ownerRole}` });
    }
    if (claims.walletId !== op.wallet_id || claims.safe === null || !isAddressEqual(claims.safe, intent.safe)) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
    }
    if (op.expires_at !== null && op.expires_at.getTime() <= this.#now()) {
      await this.#expire(op.id, op.wallet_id);
      throw new ApiError('OPERATION_EXPIRED');
    }
    const envelope = input.submissionEnvelope;
    const hash = bufferToHex(op.safe_tx_hash);
    if (envelope.operationId !== op.id || envelope.safeTxHash !== hash) {
      throw new ApiError('SUBMISSION_INVALID', { detail: 'el envelope no corresponde a esta operación o SafeTx' });
    }
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (Math.abs(nowSeconds - envelope.submittedAt) > SUBMISSION_SKEW_SECONDS) {
      throw new ApiError('SUBMISSION_INVALID', { detail: 'submittedAt fuera de la ventana de ±60 s' });
    }
    const problem = submissionProblem({ envelope, signature: input.submissionEnvelopeSignature, claims });
    if (problem !== null) throw new ApiError('SUBMISSION_INVALID', { detail: problem });

    // Paso 3: el SafeTxHash se recalcula desde la intención guardada (nunca desde lo que manda el cliente).
    const safeTx = safeTxFromJson(intent.safeTx);
    if (safeTxHash(snapshot.chainId, intent.safe, safeTx) !== hash) {
      throw new Error(`operación ${op.id}: el SafeTxHash guardado no coincide con su intención`);
    }
    let owner: Address;
    try {
      owner = await recoverStrictSigner(hash, signature);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        throw new ApiError('SIGNATURE_INVALID', { detail: `firma ECDSA no estricta (${error.reason})` });
      }
      throw error;
    }
    const call = decodeOperation(snapshot, intent.safe, safeTx);
    if (call === null) throw new ApiError('POLICY_REJECTED', { detail: 'UNKNOWN_OPERATION' });
    const challenge = await challengeFacts(this.#d.db, op, call);
    const { ctx, verdict } = await this.#evaluate({
      walletId: op.wallet_id,
      safe: intent.safe,
      safeTx,
      call,
      role,
      scope: claims.scope,
      declaredType: intent.operationType,
      precheck: false,
      excludeOperationId: op.id,
      extraFacts: challenge,
    });
    const roleKey = role === 'U' ? ctx.state.roles.userKey : ctx.state.roles.recoveryKey;
    if (!isAddressEqual(owner, roleKey)) {
      throw new ApiError('SIGNATURE_INVALID', { detail: `la firma no es de la clave ${role} vigente on-chain` });
    }
    if (op.requires_two_factor && challenge.twoFactorVerified !== true) throw new ApiError('TWO_FACTOR_REQUIRED');
    if (safeTx.nonce < BigInt(ctx.state.nonce)) {
      await this.#supersede(op.id, op.wallet_id, 'NONCE_CONSUMED');
      throw new ApiError('NONCE_CONSUMED');
    }
    if (verdict.verdict === 'REJECT') throw new ApiError('POLICY_REJECTED', { detail: verdict.code });

    const signedAt = new Date(this.#now());
    try {
      await withTransaction(
        this.#d.db,
        async (trx) => {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['CREATED'],
            to: 'USER_SIGNED',
            actor: { type: 'USER', id: actor.userId },
            requestId: actor.meta.requestId,
            patch: {
              owner_signature: hexToBuffer(signature, 65),
              owner_role: role,
              submission_envelope: JSON.stringify(envelope),
              submission_envelope_signature: input.submissionEnvelopeSignature,
              platform_session_token: actor.session.token,
              platform_session_id: claims.sessionId,
              signed_at: signedAt,
              policy_snapshot_version: snapshot.version,
            },
          });
          await this.#d.audit.append(trx, {
            actorType: 'USER',
            actorId: actor.userId,
            userId: actor.userId,
            walletId: op.wallet_id,
            sessionId: claims.sessionId,
            eventType: 'OPERATION_SIGNATURE_RECEIVED',
            targetType: 'operation',
            targetId: op.id,
            requestId: actor.meta.requestId,
            ipPrefix: actor.meta.ipPrefix,
            payload: { role, signer: owner, safeTxHash: hash, submittedAt: envelope.submittedAt },
          });
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['USER_SIGNED'],
            to: 'QUEUED',
            actor: { type: 'USER', id: actor.userId },
            requestId: actor.meta.requestId,
            outbox: { eventType: 'OPERATION_QUEUED', payload: { operationId: op.id, walletId: op.wallet_id } },
          });
        },
        { auditLock: true },
      );
    } catch (error) {
      if (error instanceof TransitionConflictError) throw new ApiError('OPERATION_NOT_PENDING');
      if (
        sqlState(error) === '23505' &&
        (error as { constraint?: string }).constraint === 'wallet_operations_active_nonce_key'
      ) {
        throw new ApiError('NONCE_CONFLICT');
      }
      throw error;
    }
    this.#d.metrics?.operationTransitions.inc({ to: 'USER_SIGNED' });
    this.#d.metrics?.operationTransitions.inc({ to: 'QUEUED' });
    return this.get(actor.userId, op.id);
  }

  async #expire(operationId: string, walletId: string): Promise<void> {
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await lockWallet(trx, walletId);
        await this.#expireStaleIn(trx, walletId);
      },
      { auditLock: true },
    ).catch((error: unknown) => {
      if (!(error instanceof TransitionConflictError)) throw error;
    });
    this.#d.logger.info({ operationId }, 'operación vencida sin firma');
  }

  /** CREATED cuyo nonce ya se consumió on-chain: CANCELLED (el nonce no vuelve, ya se usó). */
  async #supersede(operationId: string, walletId: string, reason: string): Promise<void> {
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await lockWallet(trx, walletId);
        await this.#d.machine.transitionIn(trx, {
          operationId,
          from: ['CREATED'],
          to: 'CANCELLED',
          actor: { type: 'SYSTEM', id: 'nonce-check' },
          patch: { failure_reason: reason },
        });
        await refreshNextNonce(trx, walletId);
      },
      { auditLock: true },
    ).catch((error: unknown) => {
      if (!(error instanceof TransitionConflictError)) throw error;
    });
  }

  /**
   * POST /operations/{id}/cancel [B-NONCE-06]: sin firma → CANCELLED (nonce liberado); firmada → CANCEL_REQUESTED y
   * NOOP_CANCEL con el mismo nonce para que U (o R) la firme. VALIDATING es transitorio: el cliente reintenta.
   */
  async cancel(
    actor: OperationActor,
    operationId: string,
  ): Promise<{ operation: OperationView; noop: PreparedOperation | null }> {
    const op = await this.#operationFor(actor.userId, operationId);
    const role = roleForScope(actor.session.claims.scope);
    const wallet = await this.#walletFor(actor, op.wallet_id);
    if (op.status === 'CREATED') {
      try {
        const result = await withTransaction(
          this.#d.db,
          async (trx) => {
            await lockWallet(trx, op.wallet_id);
            const transition = await this.#d.machine.transitionIn(trx, {
              operationId: op.id,
              from: ['CREATED'],
              to: 'CANCELLED',
              actor: { type: 'USER', id: actor.userId },
              requestId: actor.meta.requestId,
              patch: { failure_reason: 'USER_CANCELLED' },
            });
            await refreshNextNonce(trx, op.wallet_id);
            return transition;
          },
          { auditLock: true },
        );
        this.#record(result);
      } catch (error) {
        if (error instanceof TransitionConflictError) throw new ApiError('OPERATION_NOT_PENDING');
        throw error;
      }
      return { operation: await this.get(actor.userId, op.id), noop: null };
    }
    if (op.status === 'VALIDATING') throw new ApiError('OPERATION_BUSY');
    // Una NoOp firmada ya es la cancelación de su nonce: no se cancela con otra NoOp idéntica.
    if (op.operation_type === 'NOOP_CANCEL') {
      throw new ApiError('OPERATION_NOT_PENDING', { detail: 'una NoOp firmada no se cancela' });
    }
    if (op.status !== 'CANCEL_REQUESTED' && !CANCELLABLE.includes(op.status)) {
      throw new ApiError('OPERATION_NOT_PENDING', { detail: `la operación está en ${op.status}` });
    }
    if (op.status === 'CANCEL_REQUESTED') {
      // Ya pedida: si hay una NoOp viva se devuelve esa; si venció o falló, se prepara otra.
      const live = await this.#d.db
        .selectFrom('wallet_operations')
        .select(['id', 'status', 'expires_at'])
        .where('cancels_operation_id', '=', op.id)
        .where('status', 'not in', ['EXPIRED', 'CANCELLED', 'FAILED_FINAL'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (
        live &&
        !(live.status === 'CREATED' && live.expires_at !== null && live.expires_at.getTime() <= this.#now())
      ) {
        throw new ApiError('OPERATION_NOT_PENDING', { detail: 'la cancelación ya está en curso' });
      }
    } else {
      try {
        const result = await this.#d.machine.transition({
          operationId: op.id,
          from: CANCELLABLE,
          to: 'CANCEL_REQUESTED',
          actor: { type: 'USER', id: actor.userId },
          requestId: actor.meta.requestId,
          patch: { blocked_reason: null },
          detail: { reason: 'USER_REQUESTED' },
        });
        this.#record(result);
      } catch (error) {
        if (error instanceof TransitionConflictError) throw new ApiError('OPERATION_BUSY');
        throw error;
      }
    }
    const noop = await this.#prepareFor(
      actor,
      wallet,
      role,
      { walletId: wallet.id, operationType: 'NOOP_CANCEL', call: { to: wallet.safe, data: '0x' } },
      { operationId: op.id, nonce: BigInt(op.safe_nonce) },
    );
    return { operation: await this.get(actor.userId, op.id), noop };
  }

  #record(result: TransitionResult): void {
    this.#d.metrics?.operationTransitions.inc({ to: result.to });
  }

  async get(userId: string, operationId: string): Promise<OperationView> {
    const op = await this.#operationFor(userId, operationId);
    const history = await this.#history([op.id]);
    return operationView(op, history.get(op.id) ?? []);
  }

  async list(
    userId: string,
    walletId: string,
    options: { limit: number; before?: string },
  ): Promise<{ items: OperationView[]; nextCursor: string | null }> {
    if (!isUuid(walletId)) throw new ApiError('NOT_FOUND');
    const wallet = await this.#d.db
      .selectFrom('wallets')
      .select(['user_id'])
      .where('id', '=', walletId)
      .executeTakeFirst();
    if (wallet?.user_id !== userId) throw new ApiError('NOT_FOUND');
    let query = this.#d.db
      .selectFrom('wallet_operations')
      .selectAll()
      .where('wallet_id', '=', walletId)
      .orderBy('id', 'desc')
      .limit(options.limit + 1);
    if (options.before !== undefined) {
      if (!isUuid(options.before)) throw new ApiError('VALIDATION_FAILED', { detail: 'cursor inválido' });
      query = query.where('id', '<', options.before);
    }
    const rows = await query.execute();
    const page = rows.slice(0, options.limit);
    const history = await this.#history(page.map((r) => r.id));
    return {
      items: page.map((r) => operationView(r, history.get(r.id) ?? [])),
      nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Historial de estados desde la auditoría (cada transición tiene su evento OPERATION_<ESTADO>, [B-SM-02]). */
  async #history(ids: string[]): Promise<Map<string, { status: OperationStatus; at: string }[]>> {
    const out = new Map<string, { status: OperationStatus; at: string }[]>();
    if (ids.length === 0) return out;
    const rows = await this.#d.db
      .selectFrom('audit_events')
      .select(['target_id', 'event_type', 'occurred_at'])
      .where('target_type', '=', 'operation')
      .where('target_id', 'in', ids)
      .orderBy('id', 'asc')
      .execute();
    for (const row of rows) {
      const status = row.event_type === 'OPERATION_PROPOSED' ? 'CREATED' : row.event_type.replace(/^OPERATION_/, '');
      if (!(OPERATION_STATUSES as readonly string[]).includes(status) || row.target_id === null) continue;
      const list = out.get(row.target_id) ?? [];
      list.push({ status: status as OperationStatus, at: row.occurred_at.toISOString() });
      out.set(row.target_id, list);
    }
    return out;
  }

  /**
   * Mantenimiento periódico: CREATED vencidas → EXPIRED (nonce liberado) y firmas en espera de más de 24 h
   * (QUEUED o FAILED_RETRYABLE) → FAILED_FINAL `SIGNATURE_STALE` ([B-PSES-06]).
   */
  async sweep(limit = 200): Promise<{ expired: number; stale: number }> {
    const now = new Date(this.#now());
    const wallets = await this.#d.db
      .selectFrom('wallet_operations')
      .select('wallet_id')
      .distinct()
      .where('status', '=', 'CREATED')
      .where('expires_at', '<=', now)
      .limit(limit)
      .execute();
    let expired = 0;
    for (const { wallet_id: walletId } of wallets) {
      expired += await withTransaction(
        this.#d.db,
        async (trx) => {
          await lockWallet(trx, walletId);
          return this.#expireStaleIn(trx, walletId);
        },
        { auditLock: true },
      );
    }
    const staleBefore = Math.floor(now.getTime() / 1000) - SIGNATURE_MAX_AGE_SECONDS;
    const stale = await this.#d.db
      .selectFrom('wallet_operations')
      .select(['id', 'status'])
      .where('status', 'in', ['QUEUED', 'FAILED_RETRYABLE'])
      .where(sql<boolean>`(submission_envelope ->> 'submittedAt')::bigint < ${staleBefore}`)
      .limit(limit)
      .execute();
    let staled = 0;
    for (const op of stale) {
      try {
        const result = await this.#d.machine.transition({
          operationId: op.id,
          from: [op.status],
          to: 'FAILED_FINAL',
          actor: { type: 'SYSTEM', id: 'operation-sweeper' },
          patch: { failure_reason: 'SIGNATURE_STALE', last_error_code: 'SIGNATURE_STALE', blocked_reason: null },
        });
        this.#record(result);
        staled++;
      } catch (error) {
        if (!(error instanceof TransitionConflictError)) throw error;
      }
    }
    if (expired > 0) this.#d.metrics?.operationTransitions.inc({ to: 'EXPIRED' }, expired);
    return { expired, stale: staled };
  }
}

export function operationView(
  op: NonNullable<OperationRow>,
  history: { status: OperationStatus; at: string }[],
): OperationView {
  const confirmedStates: readonly OperationStatus[] = ['CONFIRMED', 'FINALIZED'];
  return {
    id: op.id,
    walletId: op.wallet_id,
    status: op.status,
    operationType: op.operation_type,
    safeNonce: op.safe_nonce,
    safeTxHash: bufferToHex(op.safe_tx_hash),
    txHash: op.tx_hash === null ? null : bufferToHex(op.tx_hash),
    blockNumber: op.block_number,
    blockHash: op.block_hash === null ? null : bufferToHex(op.block_hash),
    confirmations: { safe: confirmedStates.includes(op.status), finalized: op.status === 'FINALIZED' },
    failureReason: op.failure_reason,
    lastErrorCode: op.last_error_code,
    blockedReason: op.blocked_reason,
    requiresTwoFactor: op.requires_two_factor,
    expiresAt: op.expires_at?.toISOString() ?? null,
    cancelsOperationId: op.cancels_operation_id,
    createdAt: op.created_at.toISOString(),
    history,
  };
}
