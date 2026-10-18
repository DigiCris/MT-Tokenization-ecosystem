// Pipeline del worker S [B-Q-02] (P13.T04/T05/T08). Por Safe, con el lease de ejecución y fencing [B-NONCE-04], en
// orden estricto de nonce [B-NONCE-03]:
//
//   1. cargar la operación (y tomar el lease de la Safe);
//   2. PlatformSession y envelope de envío, vigentes AL MOMENTO DEL ENVÍO y con la firma de menos de 24 h;
//   3. SafeTx reconstruida desde `canonical_intent` y SafeTxHash recalculado;
//   4. firma U/R ECDSA estricta contra el rol vigente on-chain;
//   5. nonce on-chain (quórum) == safe_nonce;
//   6. policy del backend (snapshot firmado, límites, ledger de 24 h, 2FA);
//   7. whitelist on-chain (quórum) y 7b: configuración de la Safe intacta (si no, SOVEREIGN_MODIFIED);
//   8. pre-check sin efectos: `evaluateAssisted` del Guard y `eth_call` de la llamada desde la Safe;
//   9. firma de S en el signer (que repite 2–8 por su cuenta y simula);
//  10. la tx firmada se registra (write-ahead, con fencing) y se transmite a los dos RPC;
//  11. espera del receipt con reemplazo por fee bump;
//  12. MINED (el watcher sigue hasta CONFIRMED/FINALIZED).
//
// Reintentos [B-Q-03]: backoff exponencial con jitter, `last_error_code` clasificado, tope de reintentos → FAILED_FINAL
// y alerta. Crash/restart [B-Q-04]: otro worker retoma VALIDATING/READY/SUBMITTED con el lease vencido; una SUBMITTED se
// reconcilia contra la cadena por sus `chain_transactions` antes de retransmitir. Nada depende de la memoria del
// worker: el estado está en la DB y cada escritura exige el lease vigente.
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Kysely, type Selectable } from 'kysely';
import { isAddressEqual, keccak256, parseTransaction, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import { RpcQuorumError, type RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { safeConfigDrift } from '../chain/safe-state.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { ChainTransactionsTable, Database, OperationStatus, WalletOperationsTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress, bufferToHex, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { challengeFacts } from '../operations/challenges.ts';
import { swapPairingFacts } from '../operations/pairing.ts';
import { decodeRevertReason, policyFactsFrom, readOperationContext } from '../operations/chain-context.ts';
import { safeTxFromJson, safeTxToJson, type CanonicalIntent } from '../operations/intent.ts';
import { dailyOutflow } from '../operations/ledger.ts';
import { roleForScope } from '../operations/service.ts';
import {
  TransitionConflictError,
  type OperationStateMachine,
  type TransitionInput,
} from '../operations/state-machine.ts';
import { submissionProblem, type SubmissionEnvelope } from '../platform-session/request-signature.ts';
import type { PlatformSessionIssuer } from '../platform-session/token.ts';
import { decodeOperation, evaluatePolicy, type PolicyRejectCode } from '../policy/evaluate.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { SignerClientError } from '../signer-client/client.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';
import type { SovereignModification } from '../wallets/sovereign.ts';
import { executionFees, FeeCapExceededError, type Fees } from './fees.ts';
import type { SafeLease } from './lease.ts';

type OperationRow = Selectable<WalletOperationsTable>;
type ChainTxRow = Selectable<ChainTransactionsTable>;

export interface PipelineOptions {
  /** Espera del receipt antes de reemplazar por fee bump. */
  receiptTimeoutMs: number;
  /** Intervalo de sondeo de receipts. */
  pollIntervalMs: number;
  /** Reemplazos por fee bump por operación (después se sigue esperando y se alerta). */
  maxReplacements: number;
  retry: { baseMs: number; maxMs: number; maxRetries: number };
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  receiptTimeoutMs: 60_000,
  pollIntervalMs: 1_000,
  maxReplacements: 3,
  retry: { baseMs: 5_000, maxMs: 10 * 60_000, maxRetries: 20 },
};

export interface PipelineDeps {
  db: Kysely<Database>;
  machine: OperationStateMachine;
  audit: AuditWriter;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  signers: SignerKeyService;
  issuer: PlatformSessionIssuer;
  sovereign: SovereignModification;
  lease: SafeLease;
  logger: Logger;
  metrics: Metrics;
  options?: Partial<PipelineOptions>;
  now?: () => number;
}

/** El worker perdió el lease (o la operación cambió de dueño): aborta sin efectos. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

/** Resultado de un paso: seguir con la próxima operación de la Safe o parar (espera, reintento, bloqueo). */
type Next = 'CONTINUE' | 'STOP';

interface Validated {
  safeTx: SafeTx;
  call: DecodedCall;
  hash: Hex;
  executor: Address;
}

const ERROR_CODE_OF_POLICY: Partial<Record<PolicyRejectCode, string>> = {
  DESTINATION_NOT_WHITELISTED: 'WHITELIST_INACTIVE',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
};

/** Errores del signer que no se resuelven reintentando la misma SafeTx. */
const SIGNER_FINAL = new Set([
  'STATIC_RULE_VIOLATION',
  'POLICY_VERSION_MISMATCH',
  'SESSION_INVALID',
  'SIGNATURE_STALE',
  'OWNER_SIGNATURE_INVALID',
  'OWNER_NOT_ROLE',
  'SAFE_NOT_REGISTERED',
  'SAFE_CONFIG_MODIFIED',
  'NONCE_CONSUMED',
  'KEY_NOT_FOUND',
  'POLICY_REJECTED',
  'GUARD_WOULD_REVERT',
  'SAFE_NONCE_CONFLICT',
  'SIMULATION_REVERTED',
]);

class LeaseHandle {
  lost = false;
  readonly #timer: NodeJS.Timeout;

  constructor(lease: SafeLease, walletId: string, version: bigint, logger: Logger) {
    this.#timer = setInterval(
      () => {
        lease
          .renew(walletId, version)
          .then((ok) => {
            if (!ok) this.lost = true;
          })
          .catch((error: unknown) => {
            logger.warn({ err: error, walletId }, 'no se pudo renovar el lease de la Safe');
          });
      },
      Math.max(500, Math.floor(lease.ttlMs / 3)),
    );
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}

export class OperationPipeline {
  readonly #d: PipelineDeps;
  readonly #o: PipelineOptions;

  constructor(deps: PipelineDeps) {
    this.#d = deps;
    this.#o = { ...DEFAULT_PIPELINE_OPTIONS, ...deps.options };
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /**
   * Procesa la Safe: toma el lease y ejecuta en orden de nonce todas las operaciones listas. Si otro worker tiene el
   * lease, no hace nada (ese worker procesa la Safe completa antes de soltarlo).
   */
  async processWallet(walletId: string): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const version = await this.#d.lease.acquire(walletId);
      if (version === null) {
        this.#d.logger.debug({ walletId }, 'otro worker tiene el lease de la Safe');
        return;
      }
      const handle = new LeaseHandle(this.#d.lease, walletId, version, this.#d.logger);
      try {
        await this.#drain(walletId, version, handle);
      } catch (error) {
        if (!(error instanceof LeaseLostError) && !(error instanceof TransitionConflictError)) throw error;
        this.#d.logger.warn({ walletId, lease: version.toString(), err: error }, 'el worker perdió el lease: aborta');
        return;
      } finally {
        handle.stop();
        await this.#d.lease.release(walletId, version);
      }
      // Entre el último chequeo y la liberación pudo encolarse otra operación de la Safe.
      if (!(await this.#hasWork(walletId))) return;
    }
  }

  async #hasWork(walletId: string): Promise<boolean> {
    const row = await this.#d.db
      .selectFrom('wallet_operations')
      .select('id')
      .where('wallet_id', '=', walletId)
      .where('status', 'in', ['QUEUED', 'VALIDATING', 'READY', 'SUBMITTED'])
      .where('blocked_reason', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async #drain(walletId: string, version: bigint, handle: LeaseHandle): Promise<void> {
    for (let i = 0; i < 1_000; i++) {
      if (handle.lost) throw new LeaseLostError('lease vencido o tomado por otro worker');
      const op = await this.#d.db
        .selectFrom('wallet_operations')
        .selectAll()
        .where('wallet_id', '=', walletId)
        .where('status', 'in', ['QUEUED', 'VALIDATING', 'READY', 'SUBMITTED'])
        .orderBy('safe_nonce', 'asc')
        .orderBy((eb) => eb.case().when('status', '=', 'QUEUED').then(1).else(0).end(), 'asc')
        .orderBy('created_at', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (!op) return;
      const next = await this.#run(op, version, handle);
      if (next === 'STOP') return;
    }
  }

  async #run(op: OperationRow, version: bigint, handle: LeaseHandle): Promise<Next> {
    const started = this.#now();
    this.#d.logger.debug(
      { operationId: op.id, status: op.status, nonce: op.safe_nonce, lease: version.toString() },
      'procesando operación',
    );
    let current = op;
    if (current.status === 'QUEUED') {
      const onchain = await this.#onchainNonce(current);
      if (onchain === null) return 'STOP';
      const nonce = BigInt(current.safe_nonce);
      if (nonce > onchain) {
        // [B-NONCE-03]: espera a que se ejecute el nonce menor.
        this.#d.logger.info(
          { operationId: current.id, nonce: nonce.toString(), onchain: onchain.toString() },
          'operación en espera de un nonce menor',
        );
        await this.#d.db
          .updateTable('wallet_operations')
          .set({ blocked_reason: 'WAITING_LOWER_NONCE' })
          .where('id', '=', current.id)
          .where('status', '=', 'QUEUED')
          .where('blocked_reason', 'is', null)
          .execute();
        return 'STOP';
      }
      if (nonce < onchain) {
        await this.#fail(current, ['QUEUED'], 'NONCE_CONSUMED', `nonce on-chain ${onchain.toString()}`);
        return 'CONTINUE';
      }
      await this.#transition({
        operationId: current.id,
        from: ['QUEUED'],
        to: 'VALIDATING',
        actor: this.#actor(),
        patch: { lease_version: version.toString(), blocked_reason: null },
      });
      current = { ...current, status: 'VALIDATING', lease_version: version.toString() };
    } else if (BigInt(current.lease_version) !== version) {
      current = await this.#reclaim(current, version);
    }
    this.#d.metrics.workerStepDuration.observe({ step: 'claim' }, (this.#now() - started) / 1000);

    if (current.status === 'VALIDATING' || current.status === 'READY') {
      const t0 = this.#now();
      const validated = await this.#validate(current, version);
      this.#d.metrics.workerStepDuration.observe({ step: 'validate' }, (this.#now() - t0) / 1000);
      if (validated === null) return 'STOP';
      if ('next' in validated) return validated.next;
      if (current.status === 'VALIDATING') {
        await this.#transition({
          operationId: current.id,
          from: ['VALIDATING'],
          to: 'READY',
          actor: this.#actor(),
          leaseVersion: version,
        });
        current = { ...current, status: 'READY' };
      }
      const t1 = this.#now();
      const submitted = await this.#signAndSubmit(current, version, validated);
      this.#d.metrics.workerStepDuration.observe({ step: 'sign_submit' }, (this.#now() - t1) / 1000);
      if (submitted !== 'SUBMITTED') return submitted;
      current = { ...current, status: 'SUBMITTED' };
    }
    if (current.status === 'SUBMITTED') {
      const t2 = this.#now();
      const next = await this.#awaitExecution(current, version, handle);
      this.#d.metrics.workerStepDuration.observe({ step: 'await_receipt' }, (this.#now() - t2) / 1000);
      return next;
    }
    return 'STOP';
  }

  #actor() {
    return { type: 'WORKER' as const, id: this.#d.lease.owner };
  }

  async #transition(input: TransitionInput): Promise<void> {
    const result = await this.#d.machine.transition(input);
    this.#d.metrics.operationTransitions.inc({ to: result.to });
  }

  /** Recupera una operación en curso de otro worker cuyo lease venció [B-Q-04] (auditado, con fencing). */
  async #reclaim(op: OperationRow, version: bigint): Promise<OperationRow> {
    const reclaimed = await withTransaction(
      this.#d.db,
      async (trx) => {
        const row = await trx
          .updateTable('wallet_operations')
          .set({ lease_version: version.toString() })
          .where('id', '=', op.id)
          .where('status', '=', op.status)
          .where('lease_version', '<', version.toString())
          .returningAll()
          .executeTakeFirst();
        if (!row) throw new LeaseLostError(`operación ${op.id} tomada por otro worker`);
        await this.#d.audit.append(trx, {
          actorType: 'WORKER',
          actorId: this.#d.lease.owner,
          userId: op.user_id,
          walletId: op.wallet_id,
          eventType: 'OPERATION_RECLAIMED',
          targetType: 'operation',
          targetId: op.id,
          payload: { status: op.status, fromLease: op.lease_version, toLease: version.toString() },
        });
        return row;
      },
      { auditLock: true },
    );
    this.#d.logger.info({ operationId: op.id, status: op.status }, 'operación retomada tras lease vencido');
    return reclaimed;
  }

  async #onchainNonce(op: OperationRow): Promise<bigint | null> {
    try {
      const { value } = await this.#d.rpc.readSensitive('safe-nonce', (client, blockNumber) =>
        client.readContract({
          address: bufferToAddress(op.safe_address),
          abi: [
            {
              type: 'function',
              name: 'nonce',
              stateMutability: 'view',
              inputs: [],
              outputs: [{ name: '', type: 'uint256' }],
            },
          ] as const,
          functionName: 'nonce',
          blockNumber,
        }),
      );
      return value;
    } catch (error) {
      if (error instanceof RpcQuorumError) {
        this.#d.metrics.operationErrors.inc({ code: error.code });
        this.#d.logger.warn({ operationId: op.id, code: error.code }, 'nonce on-chain sin quórum: se reintenta');
        return null;
      }
      throw error;
    }
  }

  // --- Pasos 2–8 ----------------------------------------------------------------------------------------------

  /**
   * Validación completa (VALIDATING o READY retomada). null: error transitorio ya registrado (reintento); `next`: la
   * operación terminó (FAILED_FINAL) o queda esperando.
   */
  async #validate(op: OperationRow, version: bigint): Promise<Validated | { next: Next } | null> {
    const from: OperationStatus[] = [op.status];
    const snapshot = this.#d.snapshot();
    const intent = op.canonical_intent as CanonicalIntent;
    const safe = intent.safe;
    // 2. PlatformSession y envelope al momento del envío; antigüedad ≤ 24 h al ejecutar.
    const envelope = op.submission_envelope as SubmissionEnvelope | null;
    if (envelope === null || op.platform_session_token === null || op.submission_envelope_signature === null) {
      await this.#fail(op, from, 'SESSION_INVALID', 'falta el envelope de envío', version);
      return { next: 'CONTINUE' };
    }
    let claims;
    try {
      claims = await this.#d.issuer.verify(op.platform_session_token, envelope.submittedAt * 1000);
    } catch {
      await this.#fail(op, from, 'SESSION_INVALID', 'PlatformSession inválida al momento del envío', version);
      return { next: 'CONTINUE' };
    }
    const sessionMatches =
      claims.userId === op.user_id &&
      claims.walletId === op.wallet_id &&
      claims.safe !== null &&
      isAddressEqual(claims.safe, safe) &&
      claims.sessionId === op.platform_session_id &&
      op.owner_role !== null &&
      roleForScopeSafe(claims.scope) === op.owner_role;
    const problem = sessionMatches
      ? submissionProblem({
          envelope,
          signature: op.submission_envelope_signature,
          claims,
          executionTime: this.#now(),
        })
      : 'SESSION_MISMATCH';
    if (problem === 'STALE') {
      await this.#fail(op, from, 'SIGNATURE_STALE', 'la firma supera las 24 h desde el envío', version);
      return { next: 'CONTINUE' };
    }
    if (problem !== null) {
      await this.#fail(op, from, 'SESSION_INVALID', problem, version);
      return { next: 'CONTINUE' };
    }
    // 3. SafeTxHash recalculado.
    const safeTx = safeTxFromJson(intent.safeTx);
    const hash = safeTxHash(snapshot.chainId, safe, safeTx);
    if (hash !== bufferToHex(op.safe_tx_hash) || op.owner_signature === null) {
      await this.#fail(op, from, 'INTEGRITY_MISMATCH', 'el SafeTxHash no coincide con la intención', version);
      return { next: 'CONTINUE' };
    }
    // 4. Firma ECDSA estricta.
    let owner: Address;
    try {
      owner = await recoverStrictSigner(hash, bufferToHex(op.owner_signature));
    } catch (error) {
      if (!(error instanceof InvalidSignatureError)) throw error;
      await this.#fail(op, from, 'OWNER_SIGNATURE_INVALID', error.reason, version);
      return { next: 'CONTINUE' };
    }
    const call = decodeOperation(snapshot, safe, safeTx);
    if (call === null) {
      await this.#fail(op, from, 'POLICY_REJECTED', 'UNKNOWN_OPERATION', version);
      return { next: 'CONTINUE' };
    }
    let ctx;
    try {
      ({ value: ctx } = await readOperationContext(this.#d.rpc, snapshot, {
        safe,
        safeTx,
        call,
        ownerRole: op.owner_role as 'U' | 'R',
        precheck: true,
      }));
    } catch (error) {
      if (error instanceof RpcQuorumError) {
        await this.#retry(op, from, error.code, version);
        return null;
      }
      throw error;
    }
    // 7b. Configuración de la Safe intacta (antes que nada que dependa del Guard).
    const drift = safeConfigDrift(ctx.state, snapshot);
    if (drift.length > 0) {
      await withTransaction(
        this.#d.db,
        (trx) =>
          this.#d.sovereign.mark(trx, { walletId: op.wallet_id, safe, items: drift, detectedBy: this.#d.lease.owner }),
        { auditLock: true },
      );
      await this.#fail(op, from, 'SAFE_CONFIG_MODIFIED', drift.join(','), version);
      return { next: 'CONTINUE' };
    }
    const roleKey = op.owner_role === 'U' ? ctx.state.roles.userKey : ctx.state.roles.recoveryKey;
    if (!isAddressEqual(owner, roleKey)) {
      await this.#fail(op, from, 'OWNER_NOT_ROLE', `la firma no es de la ${op.owner_role} vigente`, version);
      return { next: 'CONTINUE' };
    }
    // 5. Nonce on-chain.
    const onchain = BigInt(ctx.state.nonce);
    if (safeTx.nonce < onchain) {
      await this.#fail(op, from, 'NONCE_CONSUMED', `nonce on-chain ${onchain.toString()}`, version);
      return { next: 'CONTINUE' };
    }
    if (safeTx.nonce > onchain) {
      await this.#retry(op, from, 'NONCE_NOT_REACHED', version);
      return null;
    }
    // 6 y 7. Policy con los hechos on-chain, el ledger de 24 h y los challenges.
    const facts = policyFactsFrom(ctx);
    facts.dailyOutflowUsed = await dailyOutflow(this.#d.db, {
      walletId: op.wallet_id,
      nonce: safeTx.nonce,
      excludeOperationId: op.id,
      amount: call.kind === 'ERC20_TRANSFER' ? call.amount : 0n,
    });
    Object.assign(facts, await challengeFacts(this.#d.db, op, call));
    // Par de un swap [B-SIG-02]: SWAP N+1 firmado por la U vigente (approve) o approve N−1 ya co-firmado por S (swap).
    Object.assign(
      facts,
      await swapPairingFacts(this.#d.db, op, call, {
        mode: 'execute',
        chainId: snapshot.chainId,
        userKey: ctx.state.roles.userKey,
      }),
    );
    const verdict = evaluatePolicy(snapshot, {
      safe,
      role: op.owner_role as 'U' | 'R',
      scope: claims.scope,
      declaredType: intent.operationType,
      safeTx,
      facts,
    });
    if (verdict.verdict === 'REJECT') {
      await this.#fail(op, from, ERROR_CODE_OF_POLICY[verdict.code] ?? 'POLICY_REJECTED', verdict.code, version);
      return { next: 'CONTINUE' };
    }
    // 8. Pre-check sin efectos.
    if (ctx.precheck && !ctx.precheck.guardOk) {
      await this.#fail(op, from, 'GUARD_WOULD_REVERT', decodeRevertReason(ctx.precheck.guardReason), version);
      return { next: 'CONTINUE' };
    }
    if (ctx.precheck && !ctx.precheck.callOk) {
      await this.#fail(op, from, 'GUARD_WOULD_REVERT', decodeRevertReason(ctx.precheck.callRevert), version);
      return { next: 'CONTINUE' };
    }
    return { safeTx, call, hash, executor: ctx.state.roles.executor };
  }

  // --- Pasos 9 y 10 -------------------------------------------------------------------------------------------

  async #signAndSubmit(op: OperationRow, version: bigint, v: Validated): Promise<Next | 'SUBMITTED'> {
    const snapshot = this.#d.snapshot();
    const intent = op.canonical_intent as CanonicalIntent;
    const key = await this.#d.signers.activeKey(op.wallet_id);
    if (key === undefined || !isAddressEqual(key.address, v.executor)) {
      await this.#fail(op, ['READY'], 'KEY_NOT_FOUND', 'la S vigente on-chain no es la registrada', version);
      return 'CONTINUE';
    }
    let accountNonce: bigint;
    let fees: Fees;
    let inflight: ChainTxRow | undefined;
    try {
      ({ value: accountNonce } = await this.#d.rpc.getTransactionCount(v.executor));
      // Una tx de S en vuelo con ese nonce de cuenta (reintento de esta operación o la original de una NoOp): la
      // nueva la reemplaza con fee bump ([B-NONCE-05/06]).
      inflight = await this.#d.db
        .selectFrom('chain_transactions')
        .selectAll()
        .where('chain_id', '=', snapshot.chainId)
        .where('from_address', '=', addressToBuffer(v.executor))
        .where('account_nonce', '=', accountNonce.toString())
        .where('status', '=', 'BROADCAST')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      fees = await executionFees(
        this.#d.rpc,
        snapshot,
        inflight
          ? {
              maxFeePerGas: BigInt(inflight.max_fee_per_gas),
              maxPriorityFeePerGas: BigInt(inflight.max_priority_fee_per_gas),
            }
          : undefined,
      );
    } catch (error) {
      if (error instanceof RpcQuorumError) {
        await this.#retry(op, ['READY'], error.code, version);
        return 'STOP';
      }
      if (error instanceof FeeCapExceededError) {
        this.#d.logger.error({ alert: 'FEE_CAP', operationId: op.id }, error.message);
        await this.#retry(op, ['READY'], 'FEE_CAP_EXCEEDED', version);
        return 'STOP';
      }
      throw error;
    }
    const body = await this.#signRequest(op, intent, v, accountNonce, fees);
    let signed;
    try {
      signed = await this.#d.signers.client(key.shardId).signSafeTx(body);
      this.#d.metrics.signerRequests.inc({ shard: key.shardId, route: 'sign-safe-tx', result: 'ok' });
    } catch (error) {
      if (!(error instanceof SignerClientError)) throw error;
      this.#d.metrics.signerRequests.inc({ shard: key.shardId, route: 'sign-safe-tx', result: error.code });
      if (error.code === 'SAFE_CONFIG_MODIFIED') {
        await this.#fail(op, ['READY'], 'SAFE_CONFIG_MODIFIED', error.reason ?? 'signer', version);
        return 'CONTINUE';
      }
      if (error.retryable || !SIGNER_FINAL.has(error.code)) {
        await this.#retry(op, ['READY'], error.code === 'SIGNER_ERROR' ? 'SIGNER_UNAVAILABLE' : error.code, version);
        return 'STOP';
      }
      await this.#fail(op, ['READY'], error.code, error.reason ?? 'rechazado por el signer', version);
      return 'CONTINUE';
    }
    // La respuesta se verifica antes de registrarla: misma SafeTx, S vigente, tx hacia la propia Safe con el nonce
    // de cuenta pedido y hash consistente.
    const parsed = parseTransaction(signed.signedTx);
    if (
      signed.safeTxHash.toLowerCase() !== v.hash ||
      !isAddressEqual(signed.executor, v.executor) ||
      BigInt(signed.accountNonce) !== accountNonce ||
      keccak256(signed.signedTx) !== signed.txHash.toLowerCase() ||
      parsed.to === undefined ||
      parsed.to === null ||
      !isAddressEqual(parsed.to, intent.safe) ||
      BigInt(parsed.nonce ?? -1) !== accountNonce ||
      parsed.chainId !== snapshot.chainId
    ) {
      this.#d.logger.error(
        { alert: 'SIGNER_RESPONSE_MISMATCH', operationId: op.id },
        'respuesta del signer inconsistente',
      );
      await this.#retry(op, ['READY'], 'SIGNER_RESPONSE_MISMATCH', version);
      return 'STOP';
    }
    // 10. Write-ahead: la tx firmada queda registrada (y la operación SUBMITTED) antes de transmitirse. Si otro
    // worker tomó la operación, el fencing aborta acá y esta tx nunca se transmite.
    await withTransaction(
      this.#d.db,
      async (trx) => {
        const inserted = await trx
          .insertInto('chain_transactions')
          .values({
            chain_id: snapshot.chainId,
            operation_id: op.id,
            purpose: 'EXEC',
            from_address: addressToBuffer(v.executor),
            account_nonce: accountNonce.toString(),
            tx_hash: hexToBuffer(signed.txHash, 32),
            raw_tx: hexToBuffer(signed.signedTx),
            max_fee_per_gas: fees.maxFeePerGas.toString(),
            max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
            gas_limit: signed.gasLimit,
            status: 'BROADCAST',
          })
          // La misma SafeTx con el mismo nonce de cuenta y los mismos fees produce la misma tx (firma determinística): tras
          // un reorg o un descarte se vuelve a armar la fila de esta operación en lugar de duplicarla.
          .onConflict((oc) =>
            oc
              .column('tx_hash')
              .doUpdateSet({
                status: 'BROADCAST',
                block_number: null,
                block_hash: null,
                receipt_status: null,
                gas_used: null,
                effective_gas_price: null,
                updated_at: sql`now()`,
              })
              .where('chain_transactions.operation_id', '=', op.id),
          )
          .returning('id')
          .executeTakeFirst();
        if (inserted && inflight && inflight.id !== inserted.id) {
          await trx
            .updateTable('chain_transactions')
            .set({ replaced_by_id: inserted.id })
            .where('id', '=', inflight.id)
            .execute();
        }
        await this.#d.machine.transitionIn(trx, {
          operationId: op.id,
          from: ['READY'],
          to: 'SUBMITTED',
          actor: this.#actor(),
          leaseVersion: version,
          patch: {
            s_signature: hexToBuffer(signed.sSignature, 65),
            tx_hash: hexToBuffer(signed.txHash, 32),
            submitted_at: new Date(this.#now()),
            last_error_code: null,
          },
        });
        await this.#d.audit.append(trx, {
          actorType: 'WORKER',
          actorId: this.#d.lease.owner,
          userId: op.user_id,
          walletId: op.wallet_id,
          eventType: 'S_SIGNATURE_ISSUED',
          targetType: 'operation',
          targetId: op.id,
          payload: {
            executor: v.executor,
            shardId: key.shardId,
            txHash: signed.txHash,
            accountNonce: accountNonce.toString(),
            replaces: inflight ? bufferToHex(inflight.tx_hash) : null,
          },
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.operationTransitions.inc({ to: 'SUBMITTED' });
    await this.#broadcast(op, signed.signedTx, signed.txHash);
    return 'SUBMITTED';
  }

  async #signRequest(op: OperationRow, intent: CanonicalIntent, v: Validated, accountNonce: bigint, fees: Fees) {
    const snapshot = this.#d.snapshot();
    const envelope = op.submission_envelope as SubmissionEnvelope;
    const body: Record<string, unknown> = {
      operationId: op.id,
      walletId: op.wallet_id,
      safe: intent.safe,
      chainId: snapshot.chainId,
      operationType: intent.operationType,
      safeTx: safeTxToJson(v.safeTx),
      ownerSignature: bufferToHex(op.owner_signature ?? Buffer.alloc(0)),
      ownerRole: op.owner_role,
      platformSessionToken: op.platform_session_token,
      submissionEnvelope: envelope,
      submissionEnvelopeSignature: op.submission_envelope_signature,
      policySnapshotVersion: snapshot.version,
      execution: {
        accountNonce: accountNonce.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
    };
    if (op.challenge_attestation !== null) body.challengeAttestation = op.challenge_attestation;
    // Otra SafeTx del mismo nonce que S ya co-firmó (p. ej. una FAILED_FINAL): el reemplazo es explícito.
    if (intent.operationType !== 'NOOP_CANCEL') {
      const previous = await this.#d.db
        .selectFrom('wallet_operations')
        .select('safe_tx_hash')
        .where('wallet_id', '=', op.wallet_id)
        .where('safe_nonce', '=', op.safe_nonce)
        .where('id', '<>', op.id)
        .where('s_signature', 'is not', null)
        .orderBy('updated_at', 'desc')
        .executeTakeFirst();
      if (previous) body.replacesSafeTxHash = bufferToHex(previous.safe_tx_hash);
    }
    // SWAP_APPROVE: el SWAP N+1 del mismo grupo, firmado por U, viaja junto para el chequeo de secuencia [B-SIG-02].
    if (intent.operationType === 'SWAP_APPROVE' && op.group_id !== null) {
      const paired = await this.#d.db
        .selectFrom('wallet_operations')
        .selectAll()
        .where('group_id', '=', op.group_id)
        .where('safe_nonce', '=', (BigInt(op.safe_nonce) + 1n).toString())
        .where('owner_signature', 'is not', null)
        .executeTakeFirst();
      if (paired) {
        body.pairedSafeTx = {
          operationId: paired.id,
          safeTx: (paired.canonical_intent as CanonicalIntent).safeTx,
          ownerSignature: bufferToHex(paired.owner_signature ?? Buffer.alloc(0)),
          submissionEnvelope: paired.submission_envelope,
          submissionEnvelopeSignature: paired.submission_envelope_signature,
        };
      }
    }
    return body;
  }

  /** [B-RPC-03]: a los dos proveedores, idempotente por hash. Un rechazo no cambia el estado: decide el receipt. */
  async #broadcast(op: OperationRow, raw: Hex, txHash: Hex): Promise<boolean> {
    try {
      const { acceptedBy } = await this.#d.rpc.sendRawTransaction(raw);
      this.#d.metrics.executorTransactions.inc({ result: 'submitted' });
      await withTransaction(
        this.#d.db,
        (trx) =>
          this.#d.audit.append(trx, {
            actorType: 'WORKER',
            actorId: this.#d.lease.owner,
            userId: op.user_id,
            walletId: op.wallet_id,
            eventType: 'S_EXECUTION_SUBMITTED',
            targetType: 'operation',
            targetId: op.id,
            payload: { txHash, acceptedBy },
          }),
        { auditLock: true },
      );
      return true;
    } catch (error) {
      if (!(error instanceof RpcQuorumError)) throw error;
      this.#d.logger.warn({ operationId: op.id, txHash, err: error }, 'transmisión rechazada: decide el receipt');
      return false;
    }
  }

  // --- Pasos 11 y 12 ------------------------------------------------------------------------------------------

  async #awaitExecution(op: OperationRow, version: bigint, handle: LeaseHandle): Promise<Next> {
    const snapshot = this.#d.snapshot();
    const intent = op.canonical_intent as CanonicalIntent;
    let deadline = this.#now() + this.#o.receiptTimeoutMs;
    let polls = 0;
    for (;;) {
      if (handle.lost) throw new LeaseLostError('lease perdido esperando el receipt');
      // Si la operación salió de SUBMITTED por otro camino (el usuario pidió cancelar, el watcher la resolvió), se
      // deja de esperar: la próxima de la Safe (p. ej. la NoOp del mismo nonce) se procesa con este mismo lease.
      const current = await this.#d.db
        .selectFrom('wallet_operations')
        .select(['status', 'lease_version'])
        .where('id', '=', op.id)
        .executeTakeFirstOrThrow();
      if (current.status !== 'SUBMITTED') return 'CONTINUE';
      if (BigInt(current.lease_version) !== version)
        throw new LeaseLostError(`operación ${op.id} tomada por otro worker`);
      const own = await this.#txsOf(op.id);
      const pending = own.filter((t) => t.status === 'BROADCAST');
      // Una NoOp también mira la tx en vuelo de la operación que cancela: gana la que se mine primero.
      const rivals = op.cancels_operation_id === null ? [] : await this.#txsOf(op.cancels_operation_id);
      try {
        // El nonce de cuenta de S se lee ANTES que los receipts: si avanzó y aun así ninguna tx nuestra tiene receipt,
        // la tx fue reemplazada o descartada (leído al revés, un bloque minado entre las dos lecturas se confundiría
        // con un descarte).
        const latest = pending.reduce<ChainTxRow | undefined>(
          (a, b) => (a === undefined || b.created_at > a.created_at ? b : a),
          undefined,
        );
        const accountNonce =
          latest === undefined
            ? undefined
            : (await this.#d.rpc.getTransactionCount(bufferToAddress(latest.from_address))).value;
        for (const tx of pending) {
          const receipt = await this.#d.rpc.getTransactionReceipt(bufferToHex(tx.tx_hash));
          if (receipt === null) continue;
          if (receipt.status === 'success') {
            await this.#mined(op, tx, receipt, version);
            return 'CONTINUE';
          }
          return await this.#reverted(op, tx, receipt, version);
        }
        for (const tx of rivals.filter((t) => t.status === 'BROADCAST')) {
          const receipt = await this.#d.rpc.getTransactionReceipt(bufferToHex(tx.tx_hash));
          if (receipt?.status === 'success') {
            await this.#cancellationLost(op, tx, receipt, version);
            return 'CONTINUE';
          }
        }
        if (latest === undefined || accountNonce === undefined) {
          // Sin tx en vuelo registrada (no debería pasar en SUBMITTED): se vuelve a firmar y transmitir.
          await this.#retry(op, ['SUBMITTED'], 'TX_MISSING', version);
          return 'STOP';
        }
        if (accountNonce > BigInt(latest.account_nonce)) {
          // El nonce de S avanzó sin receipt de ninguna de nuestras tx: reemplazada o descartada.
          await this.#dropped(op, pending, version);
          return 'STOP';
        }
        polls++;
        if (polls % 10 === 0) await this.#broadcast(op, bufferToHex(latest.raw_tx), bufferToHex(latest.tx_hash));
        if (this.#now() > deadline) {
          const replacements = own.filter((t) => t.purpose === 'EXEC').length - 1;
          if (replacements < this.#o.maxReplacements) {
            await this.#replace(op, version, intent, latest, snapshot);
          } else {
            this.#d.logger.error(
              { alert: 'TX_STUCK', operationId: op.id, txHash: bufferToHex(latest.tx_hash) },
              'tx de S sin receipt después de los reemplazos permitidos',
            );
          }
          deadline = this.#now() + this.#o.receiptTimeoutMs;
        }
      } catch (error) {
        // [B-FIN-02]: inconsistencia o caída del RPC → se reintenta sin transición hasta lograr consistencia.
        if (!(error instanceof RpcQuorumError)) throw error;
        this.#d.metrics.operationErrors.inc({ code: error.code });
        this.#d.logger.warn({ operationId: op.id, code: error.code }, 'receipt sin quórum: se reintenta');
      }
      await sleep(this.#o.pollIntervalMs);
    }
  }

  async #txsOf(operationId: string): Promise<ChainTxRow[]> {
    return this.#d.db
      .selectFrom('chain_transactions')
      .selectAll()
      .where('operation_id', '=', operationId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Reemplazo por fee bump: misma SafeTx, mismo nonce de cuenta, nueva firma del signer (P13.T05). */
  async #replace(
    op: OperationRow,
    version: bigint,
    intent: CanonicalIntent,
    latest: ChainTxRow,
    snapshot: BackendPolicySnapshot,
  ): Promise<void> {
    const key = await this.#d.signers.activeKey(op.wallet_id);
    if (key === undefined || op.owner_signature === null) return;
    let fees: Fees;
    try {
      fees = await executionFees(this.#d.rpc, snapshot, {
        maxFeePerGas: BigInt(latest.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(latest.max_priority_fee_per_gas),
      });
    } catch (error) {
      if (error instanceof FeeCapExceededError) {
        this.#d.logger.error({ alert: 'FEE_CAP', operationId: op.id }, error.message);
        return;
      }
      throw error;
    }
    const safeTx = safeTxFromJson(intent.safeTx);
    const v: Validated = {
      safeTx,
      call: { kind: 'NOOP' },
      hash: bufferToHex(op.safe_tx_hash),
      executor: bufferToAddress(latest.from_address),
    };
    const body = await this.#signRequest(op, intent, v, BigInt(latest.account_nonce), fees);
    let signed;
    try {
      signed = await this.#d.signers.client(key.shardId).signSafeTx(body);
    } catch (error) {
      if (!(error instanceof SignerClientError)) throw error;
      // Sin reemplazo: la tx en vuelo sigue siendo válida (el signer pudo rechazar porque ya se minó).
      this.#d.logger.warn({ operationId: op.id, code: error.code }, 'reemplazo por fee bump rechazado');
      return;
    }
    if (
      keccak256(signed.signedTx) !== signed.txHash.toLowerCase() ||
      BigInt(signed.accountNonce) !== BigInt(latest.account_nonce)
    ) {
      this.#d.logger.error({ alert: 'SIGNER_RESPONSE_MISMATCH', operationId: op.id }, 'reemplazo inconsistente');
      return;
    }
    await withTransaction(
      this.#d.db,
      async (trx) => {
        const fenced = await trx
          .updateTable('wallet_operations')
          .set({ tx_hash: hexToBuffer(signed.txHash, 32) })
          .where('id', '=', op.id)
          .where('status', '=', 'SUBMITTED')
          .where('lease_version', '=', version.toString())
          .executeTakeFirst();
        if (fenced.numUpdatedRows === 0n) throw new LeaseLostError(`operación ${op.id} cambió durante el reemplazo`);
        const inserted = await trx
          .insertInto('chain_transactions')
          .values({
            chain_id: snapshot.chainId,
            operation_id: op.id,
            purpose: 'EXEC',
            from_address: latest.from_address,
            account_nonce: latest.account_nonce,
            tx_hash: hexToBuffer(signed.txHash, 32),
            raw_tx: hexToBuffer(signed.signedTx),
            max_fee_per_gas: fees.maxFeePerGas.toString(),
            max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
            gas_limit: signed.gasLimit,
            status: 'BROADCAST',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('chain_transactions')
          .set({ replaced_by_id: inserted.id })
          .where('id', '=', latest.id)
          .execute();
        await this.#d.audit.append(trx, {
          actorType: 'WORKER',
          actorId: this.#d.lease.owner,
          userId: op.user_id,
          walletId: op.wallet_id,
          eventType: 'S_SIGNATURE_ISSUED',
          targetType: 'operation',
          targetId: op.id,
          payload: {
            executor: bufferToHex(latest.from_address),
            txHash: signed.txHash,
            accountNonce: latest.account_nonce,
            replaces: bufferToHex(latest.tx_hash),
            reason: 'FEE_BUMP',
          },
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.executorTransactions.inc({ result: 'replaced' });
    await this.#broadcast(op, signed.signedTx, signed.txHash);
  }

  /** 12. Receipt success: MINED (+ la original CANCELLED si era una NoOp que ganó la carrera). */
  async #mined(op: OperationRow, tx: ChainTxRow, receipt: TransactionReceipt, version: bigint): Promise<void> {
    const block = await this.#blockTimestamp(receipt.blockNumber);
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#recordReceipt(trx, tx, receipt, 'MINED');
        await this.#d.machine.transitionIn(trx, {
          operationId: op.id,
          from: ['SUBMITTED'],
          to: 'MINED',
          actor: this.#actor(),
          leaseVersion: version,
          patch: {
            tx_hash: tx.tx_hash,
            block_number: receipt.blockNumber.toString(),
            block_hash: hexToBuffer(receipt.blockHash, 32),
            mined_at: new Date(this.#now()),
            executed_at: block,
            last_error_code: null,
          },
          detail: { txHash: bufferToHex(tx.tx_hash), blockNumber: receipt.blockNumber.toString() },
        });
        if (op.cancels_operation_id !== null) {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.cancels_operation_id,
            from: ['CANCEL_REQUESTED'],
            to: 'CANCELLED',
            actor: this.#actor(),
            patch: { failure_reason: 'SUPERSEDED_BY_NOOP' },
            detail: { noop: op.id },
          });
        }
      },
      { auditLock: true },
    );
    this.#d.metrics.operationTransitions.inc({ to: 'MINED' });
    this.#d.metrics.executorTransactions.inc({ result: 'mined' });
    if (op.cancels_operation_id !== null) this.#d.metrics.operationTransitions.inc({ to: 'CANCELLED' });
  }

  async #blockTimestamp(blockNumber: bigint): Promise<Date> {
    const { value } = await this.#d.rpc.readSensitive('block-timestamp', (client) =>
      client.getBlock({ blockNumber }).then((b) => Number(b.timestamp)),
    );
    return new Date(value * 1000);
  }

  async #recordReceipt(
    trx: Parameters<Parameters<typeof withTransaction<Database, unknown>>[1]>[0],
    tx: ChainTxRow,
    receipt: TransactionReceipt,
    status: 'MINED' | 'FAILED',
  ): Promise<void> {
    await trx
      .updateTable('chain_transactions')
      .set({
        status,
        block_number: receipt.blockNumber.toString(),
        block_hash: hexToBuffer(receipt.blockHash, 32),
        receipt_status: receipt.status === 'success' ? 1 : 0,
        gas_used: receipt.gasUsed.toString(),
        effective_gas_price: receipt.effectiveGasPrice.toString(),
        updated_at: sql`now()`,
      })
      .where('id', '=', tx.id)
      .execute();
    // Las demás tx de S con el mismo nonce de cuenta ya no pueden minarse.
    await trx
      .updateTable('chain_transactions')
      .set({ status: 'REPLACED', updated_at: sql`now()` })
      .where('chain_id', '=', tx.chain_id)
      .where('from_address', '=', tx.from_address)
      .where('account_nonce', '=', tx.account_nonce)
      .where('id', '<>', tx.id)
      .where('status', '=', 'BROADCAST')
      .execute();
  }

  /**
   * [B-SM-04] Revert minado: el nonce de S se consumió y el de la Safe no. Se re-simula: si el Guard (o la llamada)
   * revierte de forma determinística → FAILED_FINAL y alerta (divergencia entre simulación y ejecución); si no, es
   * transitorio → FAILED_RETRYABLE con re-simulación obligatoria en el próximo intento.
   */
  async #reverted(op: OperationRow, tx: ChainTxRow, receipt: TransactionReceipt, version: bigint): Promise<Next> {
    const snapshot = this.#d.snapshot();
    const intent = op.canonical_intent as CanonicalIntent;
    const safeTx = safeTxFromJson(intent.safeTx);
    const call = decodeOperation(snapshot, intent.safe, safeTx);
    let deterministic = true;
    let reason = 'REVERTED';
    if (call !== null) {
      try {
        const { value } = await readOperationContext(this.#d.rpc, snapshot, {
          safe: intent.safe,
          safeTx,
          call,
          ownerRole: op.owner_role as 'U' | 'R',
          precheck: true,
        });
        const pre = value.precheck;
        deterministic = pre !== null && (!pre.guardOk || !pre.callOk);
        if (pre && !pre.guardOk) reason = decodeRevertReason(pre.guardReason);
        else if (pre && !pre.callOk) reason = decodeRevertReason(pre.callRevert);
      } catch (error) {
        if (!(error instanceof RpcQuorumError)) throw error;
        deterministic = false;
      }
    }
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#recordReceipt(trx, tx, receipt, 'FAILED');
        if (deterministic) {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['SUBMITTED'],
            to: 'FAILED_FINAL',
            actor: this.#actor(),
            leaseVersion: version,
            patch: { failure_reason: `REVERTED:${reason}`.slice(0, 200), last_error_code: 'GUARD_WOULD_REVERT' },
            detail: { txHash: bufferToHex(tx.tx_hash), gasUsed: receipt.gasUsed.toString(), reason },
          });
        } else {
          await this.#d.machine.transitionIn(trx, {
            operationId: op.id,
            from: ['SUBMITTED'],
            to: 'FAILED_RETRYABLE',
            actor: this.#actor(),
            leaseVersion: version,
            patch: this.#retryPatch(op, 'REVERTED_TRANSIENT'),
            detail: { txHash: bufferToHex(tx.tx_hash), gasUsed: receipt.gasUsed.toString() },
          });
        }
      },
      { auditLock: true },
    );
    this.#d.metrics.executorTransactions.inc({ result: 'reverted' });
    this.#d.metrics.operationTransitions.inc({ to: deterministic ? 'FAILED_FINAL' : 'FAILED_RETRYABLE' });
    if (deterministic) {
      this.#d.logger.error(
        { alert: 'TX_REVERTED', operationId: op.id, txHash: bufferToHex(tx.tx_hash), reason },
        'execTransaction revertida on-chain (divergencia entre simulación y ejecución)',
      );
    }
    return deterministic ? 'CONTINUE' : 'STOP';
  }

  /** La original de una NoOp se minó primero: original MINED y la NoOp FAILED_FINAL ("demasiado tarde"). */
  async #cancellationLost(
    noop: OperationRow,
    rivalTx: ChainTxRow,
    receipt: TransactionReceipt,
    version: bigint,
  ): Promise<void> {
    const original = noop.cancels_operation_id;
    if (original === null) return;
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#recordReceipt(trx, rivalTx, receipt, 'MINED');
        await this.#d.machine.transitionIn(trx, {
          operationId: noop.id,
          from: ['SUBMITTED'],
          to: 'FAILED_FINAL',
          actor: this.#actor(),
          leaseVersion: version,
          patch: { failure_reason: 'CANCEL_TOO_LATE', last_error_code: 'CANCEL_TOO_LATE' },
        });
        await this.#d.machine.transitionIn(trx, {
          operationId: original,
          from: ['CANCEL_REQUESTED'],
          to: 'MINED',
          actor: this.#actor(),
          patch: {
            tx_hash: rivalTx.tx_hash,
            block_number: receipt.blockNumber.toString(),
            block_hash: hexToBuffer(receipt.blockHash, 32),
            mined_at: new Date(this.#now()),
          },
          detail: { txHash: bufferToHex(rivalTx.tx_hash), wonOver: noop.id },
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.operationTransitions.inc({ to: 'FAILED_FINAL' });
    this.#d.metrics.operationTransitions.inc({ to: 'MINED' });
  }

  /** El nonce de S avanzó sin receipt de nuestras tx: DROPPED y reintento (la SafeTx sigue siendo la misma). */
  async #dropped(op: OperationRow, pending: ChainTxRow[], version: bigint): Promise<void> {
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await trx
          .updateTable('chain_transactions')
          .set({ status: 'DROPPED', updated_at: sql`now()` })
          .where(
            'id',
            'in',
            pending.map((t) => t.id),
          )
          .where('status', '=', 'BROADCAST')
          .execute();
        await this.#d.machine.transitionIn(trx, {
          operationId: op.id,
          from: ['SUBMITTED'],
          to: 'FAILED_RETRYABLE',
          actor: this.#actor(),
          leaseVersion: version,
          patch: this.#retryPatch(op, 'TX_DROPPED'),
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.executorTransactions.inc({ result: 'dropped' });
    this.#d.metrics.operationTransitions.inc({ to: 'FAILED_RETRYABLE' });
  }

  // --- Fallas y reintentos ------------------------------------------------------------------------------------

  #retryPatch(op: OperationRow, code: string) {
    const attempt = op.retry_count + 1;
    const { baseMs, maxMs } = this.#o.retry;
    const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(op.retry_count, 20));
    // Jitter "igual": entre la mitad y el total del backoff.
    const delay = Math.floor(ceiling / 2) + randomInt(0, Math.floor(ceiling / 2) + 1);
    return {
      retry_count: attempt,
      next_attempt_at: new Date(this.#now() + delay),
      last_error_code: code,
      blocked_reason: null,
    };
  }

  /** Error transitorio [B-Q-03]: FAILED_RETRYABLE con backoff; al agotar los reintentos, FAILED_FINAL + alerta. */
  async #retry(op: OperationRow, from: OperationStatus[], code: string, version: bigint): Promise<void> {
    this.#d.metrics.operationErrors.inc({ code });
    if (op.retry_count + 1 > this.#o.retry.maxRetries) {
      this.#d.logger.error({ alert: 'RETRIES_EXHAUSTED', operationId: op.id, code }, 'reintentos agotados');
      await this.#fail(op, from, 'RETRIES_EXHAUSTED', code, version);
      return;
    }
    await this.#transition({
      operationId: op.id,
      from,
      to: 'FAILED_RETRYABLE',
      actor: this.#actor(),
      leaseVersion: version,
      patch: this.#retryPatch(op, code),
    });
    this.#d.logger.warn({ operationId: op.id, code, attempt: op.retry_count + 1 }, 'operación reintentable');
  }

  /** Falla definitiva: FAILED_FINAL con el motivo (la firma vigente habilita la cancelación por NoOp, [B-SM-03]). */
  async #fail(
    op: OperationRow,
    from: OperationStatus[],
    code: string,
    detail: string,
    version?: bigint,
  ): Promise<void> {
    this.#d.metrics.operationErrors.inc({ code });
    await this.#transition({
      operationId: op.id,
      from,
      to: 'FAILED_FINAL',
      actor: this.#actor(),
      ...(version === undefined ? {} : { leaseVersion: version }),
      patch: {
        failure_reason: `${code}: ${detail}`.slice(0, 200),
        last_error_code: code,
        blocked_reason: null,
      },
    });
    this.#d.logger.warn({ operationId: op.id, code, detail }, 'operación fallida en forma definitiva');
  }
}

function roleForScopeSafe(scope: string): 'U' | 'R' | null {
  try {
    return roleForScope(scope);
  } catch {
    return null;
  }
}
