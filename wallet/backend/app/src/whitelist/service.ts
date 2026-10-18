// Whitelist de destinos (P14.T01/T02, prompt §10, ADR-006):
//
// 1. Pedido (POST /wallets/{id}/whitelist/requests): valida el destino, rechaza duplicados (destino activo o en
//    activación, o un alta ya confirmada en curso) y crea el challenge `WHITELIST_ADD` ligado a
//    {userId, safe, chainId, destination, action, nonce, expiresAt} (un solo uso, vence a los 15 min, auditado). El
//    email muestra la acción, la dirección completa, la red, la Safe y la expiración [B-MAIL-02]. Un pedido nuevo del
//    mismo destino reemplaza al anterior que todavía esperaba el código.
// 2. Confirmación (POST /whitelist/requests/{id}/confirm): verifica el código y prepara la SafeTx
//    `DestinationWhitelist.addDestination(dest)` que firma U; en la misma transacción guarda la atestación
//    `ChallengeCompletion` (emisor de sesiones; el signer la verifica antes de co-firmar). Si el prepare falla por un
//    error transitorio el pedido queda CHALLENGE_PASSED y se puede reintentar sin otro código mientras el challenge
//    habría seguido vigente; un rechazo definitivo lo deja FAILED.
// 3. Ejecución y activación: las sigue la sincronización del worker (whitelist/sync.ts) desde los eventos on-chain.
// 4. Baja (POST /wallets/{id}/whitelist/{destination}/remove con U, o el grupo de emergencia con R): SafeTx
//    `removeDestination(dest)`, inmediata on-chain.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { encodeFunctionData, getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import { ApiError, type ErrorCode } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { ChallengeService } from '../auth/challenges.ts';
import { destinationWhitelistAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database, WhitelistedDestinationsTable, WhitelistRequestsTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import type { PreparedOperation } from '../operations/intent.ts';
import { lockWallet } from '../operations/nonce-manager.ts';
import { roleForScope, type OperationActor, type OperationService } from '../operations/service.ts';
import { isUuid, walletForActor, walletOfUser } from '../operations/wallet-access.ts';
import type { PlatformSessionIssuer } from '../platform-session/token.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { validateDestination } from './validation.ts';

type RequestRow = Selectable<WhitelistRequestsTable>;
type EntryRow = Selectable<WhitelistedDestinationsTable>;

/** Pedidos que todavía pueden avanzar (el índice único parcial impide dos por destino). */
const OPEN_REQUEST_STATUSES: readonly RequestRow['status'][] = [
  'PENDING_CHALLENGE',
  'CHALLENGE_PASSED',
  'AWAITING_SIGNATURE',
  'SUBMITTED',
  'ACTIVATING',
];
/** Rechazos del prepare que no se resuelven reintentando: el pedido queda FAILED. */
const FINAL_PREPARE_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'POLICY_REJECTED',
  'GUARD_WOULD_REVERT',
  'DESTINATION_INVALID',
  'SAFE_CONFIG_MODIFIED',
  'WALLET_NOT_ACTIVE',
  'WHITELIST_DUPLICATE',
]);
/** Ventana para reintentar el prepare tras un error transitorio, desde que se superó el challenge. */
export const CHALLENGE_PASSED_WINDOW_MS = 15 * 60_000;

export interface WhitelistRequestView {
  id: string;
  walletId: string;
  destination: Address;
  label: string;
  status: RequestRow['status'];
  challengeExpiresAt: string | null;
  operationId: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface WhitelistEntryView {
  id: string;
  destination: Address;
  label: string;
  status: EntryRow['status'];
  activatesAt: string;
  activatedAt: string | null;
  origin: 'PLATFORM' | 'SOVEREIGN';
  addedTxHash: string | null;
}

export interface WhitelistDeps {
  db: Kysely<Database>;
  operations: OperationService;
  challenges: ChallengeService;
  issuer: PlatformSessionIssuer;
  emails: EmailOutbox;
  audit: AuditWriter;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  logger: Logger;
  metrics?: Metrics;
  /** Reloj en ms (tests). */
  now?: () => number;
}

function requestView(row: RequestRow, challengeExpiresAt: Date | null): WhitelistRequestView {
  return {
    id: row.id,
    walletId: row.wallet_id,
    destination: bufferToAddress(row.destination),
    label: row.label,
    status: row.status,
    challengeExpiresAt: challengeExpiresAt?.toISOString() ?? null,
    operationId: row.operation_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
  };
}

export function entryView(row: EntryRow): WhitelistEntryView {
  return {
    id: row.id,
    destination: bufferToAddress(row.destination),
    label: row.label,
    status: row.status,
    activatesAt: row.activates_at.toISOString(),
    activatedAt: row.activated_at?.toISOString() ?? null,
    origin: row.origin,
    addedTxHash: row.added_tx_hash === null ? null : bufferToHex(row.added_tx_hash),
  };
}

export class WhitelistService {
  readonly #d: WhitelistDeps;
  #activationSeconds: number | undefined;

  constructor(deps: WhitelistDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** ACTIVATION_DELAY de DestinationWhitelist (inmutable: se lee una vez con quórum). */
  async #activationDelaySeconds(): Promise<number> {
    if (this.#activationSeconds === undefined) {
      const { value } = await this.#d.rpc.readSensitive('whitelist-activation-delay', (client, blockNumber) =>
        client.readContract({
          address: this.#d.snapshot().contracts.destinationWhitelist,
          abi: destinationWhitelistAbi,
          functionName: 'ACTIVATION_DELAY',
          blockNumber,
        }),
      );
      this.#activationSeconds = Number(value);
    }
    return this.#activationSeconds;
  }

  /** POST /wallets/{id}/whitelist/requests: challenge + email + pedido PENDING_CHALLENGE. */
  async request(
    actor: OperationActor,
    walletId: string,
    input: { destination: string; label: string },
    origin: { userAgent: string | null },
  ): Promise<WhitelistRequestView> {
    if (roleForScope(actor.session.claims.scope) !== 'U') throw new ApiError('SCOPE_NOT_ALLOWED');
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    const snapshot = this.#d.snapshot();
    const check = validateDestination(input.destination, { safe: wallet.safe, snapshot });
    if (!check.ok) throw new ApiError('DESTINATION_INVALID', { detail: check.problem });
    const destination = check.destination;
    const activationHours = Math.round((await this.#activationDelaySeconds()) / 3600);
    const result = await withTransaction(
      this.#d.db,
      async (trx) => {
        await lockWallet(trx, wallet.id);
        const live = await trx
          .selectFrom('whitelisted_destinations')
          .select('status')
          .where('wallet_id', '=', wallet.id)
          .where('destination', '=', addressToBuffer(destination))
          .where('status', 'in', ['ACTIVATING', 'ACTIVE'])
          .executeTakeFirst();
        if (live) {
          throw new ApiError('WHITELIST_DUPLICATE', {
            detail: live.status === 'ACTIVE' ? 'el destino ya está autorizado' : 'el destino ya está en activación',
          });
        }
        const open = await trx
          .selectFrom('whitelist_requests')
          .selectAll()
          .where('wallet_id', '=', wallet.id)
          .where('destination', '=', addressToBuffer(destination))
          .where('status', 'in', OPEN_REQUEST_STATUSES)
          .forUpdate()
          .executeTakeFirst();
        if (open && open.status !== 'PENDING_CHALLENGE') {
          throw new ApiError('WHITELIST_DUPLICATE', { detail: 'ya hay un alta en curso para este destino' });
        }
        if (open) {
          // Un pedido nuevo reemplaza al que todavía esperaba el código (p. ej. el email no llegó).
          await trx
            .updateTable('whitelist_requests')
            .set({ status: 'CANCELLED', failure_reason: 'SUPERSEDED' })
            .where('id', '=', open.id)
            .execute();
          if (open.challenge_id !== null) await this.#d.challenges.expire(trx, open.challenge_id);
        }
        const user = await trx
          .selectFrom('users')
          .select(['email', 'locale', 'time_zone'])
          .where('id', '=', actor.userId)
          .executeTakeFirstOrThrow();
        const requestId = randomUUID();
        const challenge = await this.#d.challenges.issue(trx, {
          userId: actor.userId,
          type: 'WHITELIST_ADD',
          walletId: wallet.id,
          ipPrefix: actor.meta.ipPrefix,
          supersede: { key: 'destination', value: destination },
          bindExpiry: true,
          binding: {
            requestId,
            userId: actor.userId,
            safe: wallet.safe,
            chainId: snapshot.chainId,
            destination,
            action: 'WHITELIST_ADD',
            nonce: `0x${randomBytes(16).toString('hex')}`,
          },
        });
        const row = await trx
          .insertInto('whitelist_requests')
          .values({
            id: requestId,
            wallet_id: wallet.id,
            user_id: actor.userId,
            destination: addressToBuffer(destination),
            label: input.label,
            status: 'PENDING_CHALLENGE',
            challenge_id: challenge.challengeId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const expiresAt = challenge.expiresAt.toISOString();
        await this.#d.emails.enqueue(trx, {
          to: user.email,
          template: 'whitelist-challenge',
          params: {
            code: challenge.secret,
            destination,
            label: input.label,
            safe: wallet.safe,
            expiresAt,
            activationHours,
            origin: { ipPrefix: actor.meta.ipPrefix, userAgent: origin.userAgent },
          },
          locale: user.locale,
          timeZone: user.time_zone,
          product: 'Wallet',
        });
        await notify(
          trx,
          {
            userId: actor.userId,
            walletId: wallet.id,
            type: 'WHITELIST_REQUESTED',
            payload: { requestId, destination, label: input.label, expiresAt },
          },
          this.#d.metrics,
        );
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: wallet.id,
          sessionId: actor.session.claims.sessionId,
          eventType: 'WHITELIST_REQUESTED',
          targetType: 'whitelist_request',
          targetId: requestId,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: {
            destination,
            label: input.label,
            challengeId: challenge.challengeId,
            expiresAt,
            ...(open ? { supersedes: open.id } : {}),
          },
        });
        return requestView(row, challenge.expiresAt);
      },
      { auditLock: true },
    );
    this.#d.metrics?.whitelistEvents.inc({ event: 'requested' });
    return result;
  }

  async #requestFor(userId: string, requestId: string): Promise<RequestRow> {
    if (!isUuid(requestId)) throw new ApiError('NOT_FOUND');
    const row = await this.#d.db
      .selectFrom('whitelist_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (row?.user_id !== userId) throw new ApiError('NOT_FOUND');
    return row;
  }

  async #close(
    requestId: string,
    from: RequestRow['status'],
    to: 'EXPIRED' | 'FAILED' | 'CANCELLED',
    reason: string,
  ): Promise<void> {
    await this.#d.db
      .updateTable('whitelist_requests')
      .set({ status: to, failure_reason: reason.slice(0, 200) })
      .where('id', '=', requestId)
      .where('status', '=', from)
      .execute();
  }

  /** POST /whitelist/requests/{id}/confirm: código → SafeTx addDestination para firmar con U. */
  async confirm(
    actor: OperationActor,
    requestId: string,
    code: string,
  ): Promise<{ request: WhitelistRequestView; operation: PreparedOperation }> {
    if (roleForScope(actor.session.claims.scope) !== 'U') throw new ApiError('SCOPE_NOT_ALLOWED');
    const request = await this.#requestFor(actor.userId, requestId);
    const wallet = await walletForActor(this.#d.db, actor, request.wallet_id);
    const destination = bufferToAddress(request.destination);
    const snapshot = this.#d.snapshot();
    if (request.status === 'PENDING_CHALLENGE') {
      await this.#verifyCode(actor, request, wallet.safe, code);
    } else if (request.status === 'CHALLENGE_PASSED') {
      // Reintento del prepare (falló por un error transitorio): sin otro código, dentro de la ventana.
      const passed = request.challenge_passed_at?.getTime() ?? 0;
      if (this.#now() - passed > CHALLENGE_PASSED_WINDOW_MS) {
        await this.#close(request.id, 'CHALLENGE_PASSED', 'EXPIRED', 'NOT_PREPARED_IN_TIME');
        throw new ApiError('INVALID_CODE', { detail: 'el código venció: pedí un alta nueva' });
      }
    } else {
      throw new ApiError('CONFLICT', { detail: `el pedido está en ${request.status}` });
    }
    const check = validateDestination(destination, { safe: wallet.safe, snapshot });
    try {
      if (!check.ok) throw new ApiError('DESTINATION_INVALID', { detail: check.problem });
      const operation = await this.#d.operations.prepare(actor, {
        walletId: wallet.id,
        operationType: 'WHITELIST_ADD',
        call: {
          to: snapshot.contracts.destinationWhitelist,
          data: encodeFunctionData({
            abi: destinationWhitelistAbi,
            functionName: 'addDestination',
            args: [destination],
          }),
        },
        extraFacts: { whitelistChallengeVerified: true },
        afterInsert: async (trx, created) => {
          if (request.challenge_id === null) throw new Error(`pedido de whitelist ${request.id} sin challenge`);
          const attestation = await this.#d.issuer.signChallengeCompletion({
            challengeId: request.challenge_id,
            type: 'WHITELIST_ADD',
            userId: actor.userId,
            safe: wallet.safe,
            chainId: snapshot.chainId,
            action: 'WHITELIST_ADD',
            destination,
            safeTxHash: created.safeTxHash,
            nonce: Number(created.nonce),
            completedAt: Math.floor(this.#now() / 1000),
          });
          const linked = await trx
            .updateTable('whitelist_requests')
            .set({ status: 'AWAITING_SIGNATURE', operation_id: created.operationId })
            .where('id', '=', request.id)
            .where('status', '=', 'CHALLENGE_PASSED')
            .returning('id')
            .executeTakeFirst();
          if (!linked) throw new ApiError('CONFLICT', { detail: 'el pedido cambió de estado' });
          await trx
            .updateTable('wallet_operations')
            .set({ challenge_attestation: attestation })
            .where('id', '=', created.operationId)
            .execute();
        },
      });
      const updated = await this.#requestFor(actor.userId, request.id);
      return { request: requestView(updated, null), operation };
    } catch (error) {
      if (error instanceof ApiError && FINAL_PREPARE_ERRORS.has(error.code)) {
        await this.#close(request.id, 'CHALLENGE_PASSED', 'FAILED', error.detail ?? error.code);
        this.#d.metrics?.whitelistEvents.inc({ event: 'prepare_rejected' });
      }
      throw error;
    }
  }

  /** Código del email: intento contado aunque falle; OK → CHALLENGE_PASSED (todo auditado). */
  async #verifyCode(actor: OperationActor, request: RequestRow, safe: Address, code: string): Promise<void> {
    const snapshot = this.#d.snapshot();
    const outcome = await withTransaction(
      this.#d.db,
      async (trx) => {
        const locked = await trx
          .selectFrom('whitelist_requests')
          .select(['status', 'challenge_id'])
          .where('id', '=', request.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (locked.status !== 'PENDING_CHALLENGE' || locked.challenge_id === null) return { error: 'STATE' as const };
        const check = await this.#d.challenges.verify(trx, {
          type: 'WHITELIST_ADD',
          challengeId: locked.challenge_id,
          userId: actor.userId,
          secret: code,
        });
        const binding = (check.binding ?? {}) as Record<string, unknown>;
        const destination = bufferToAddress(request.destination);
        const bound =
          check.result === 'OK' &&
          binding.requestId === request.id &&
          binding.userId === actor.userId &&
          binding.chainId === snapshot.chainId &&
          binding.action === 'WHITELIST_ADD' &&
          typeof binding.safe === 'string' &&
          isAddress(binding.safe) &&
          isAddressEqual(binding.safe, safe) &&
          typeof binding.destination === 'string' &&
          isAddress(binding.destination) &&
          isAddressEqual(binding.destination, destination);
        const audit = (eventType: string, payload: Record<string, unknown>) =>
          this.#d.audit.append(trx, {
            actorType: 'USER',
            actorId: actor.userId,
            userId: actor.userId,
            walletId: request.wallet_id,
            sessionId: actor.session.claims.sessionId,
            eventType,
            targetType: 'whitelist_request',
            targetId: request.id,
            requestId: actor.meta.requestId,
            ipPrefix: actor.meta.ipPrefix,
            payload,
          });
        if (!bound) {
          const result = check.result === 'OK' ? 'BINDING_MISMATCH' : check.result;
          await audit('WHITELIST_CHALLENGE_FAILED', { challengeId: locked.challenge_id, result });
          // Vencido, agotado o ya usado: el pedido no puede avanzar (hay que pedir otro).
          if (result !== 'INVALID') {
            await trx
              .updateTable('whitelist_requests')
              .set({
                status: result === 'EXPIRED' || result === 'NOT_FOUND' ? 'EXPIRED' : 'FAILED',
                failure_reason: `CHALLENGE_${result}`,
              })
              .where('id', '=', request.id)
              .execute();
          }
          return { error: result };
        }
        await trx
          .updateTable('whitelist_requests')
          .set({ status: 'CHALLENGE_PASSED', challenge_passed_at: new Date(this.#now()) })
          .where('id', '=', request.id)
          .execute();
        await audit('WHITELIST_CHALLENGE_PASSED', { challengeId: locked.challenge_id, destination });
        return { error: null };
      },
      { auditLock: true },
    );
    if (outcome.error === 'STATE') throw new ApiError('CONFLICT', { detail: 'el pedido cambió de estado' });
    if (outcome.error !== null) {
      this.#d.metrics?.whitelistEvents.inc({ event: 'challenge_failed' });
      throw new ApiError('INVALID_CODE', {
        ...(outcome.error === 'INVALID' ? {} : { detail: 'el código venció o ya no es válido: pedí un alta nueva' }),
      });
    }
    this.#d.metrics?.whitelistEvents.inc({ event: 'challenge_passed' });
  }

  /**
   * Baja de un destino (U con POST /wallets/{id}/whitelist/{destination}/remove o R desde el grupo de emergencia):
   * el destino tiene que estar en la lista on-chain (activo o pendiente); el pre-check confirma que la baja se ejecuta.
   */
  async remove(actor: OperationActor, walletId: string, destinationInput: string): Promise<PreparedOperation> {
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(destinationInput) || !isAddress(destinationInput, { strict: true })) {
      throw new ApiError('DESTINATION_INVALID', { detail: 'INVALID_FORMAT' });
    }
    const destination = getAddress(destinationInput);
    const snapshot = this.#d.snapshot();
    const { value: info } = await this.#d.rpc.readSensitive('whitelist-destination-info', (client, blockNumber) =>
      client.readContract({
        address: snapshot.contracts.destinationWhitelist,
        abi: destinationWhitelistAbi,
        functionName: 'destinationInfo',
        args: [wallet.safe, destination],
        blockNumber,
      }),
    );
    if (!info[0]) throw new ApiError('NOT_FOUND', { detail: 'el destino no está en la whitelist on-chain' });
    return this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: 'WHITELIST_REMOVE',
      call: {
        to: snapshot.contracts.destinationWhitelist,
        data: encodeFunctionData({
          abi: destinationWhitelistAbi,
          functionName: 'removeDestination',
          args: [destination],
        }),
      },
    });
  }

  /** GET /wallets/{id}/whitelist: destinos activos y en activación + pedidos abiertos. */
  async list(
    userId: string,
    walletId: string,
  ): Promise<{ entries: WhitelistEntryView[]; requests: WhitelistRequestView[] }> {
    const wallet = await walletOfUser(this.#d.db, userId, walletId);
    const entries = await this.#d.db
      .selectFrom('whitelisted_destinations')
      .selectAll()
      .where('wallet_id', '=', wallet.id)
      .where('status', 'in', ['ACTIVATING', 'ACTIVE'])
      .orderBy('created_at', 'desc')
      .execute();
    const requests = await this.#d.db
      .selectFrom('whitelist_requests as r')
      .leftJoin('security_challenges as c', 'c.id', 'r.challenge_id')
      .selectAll('r')
      .select(['c.expires_at as challenge_expires_at'])
      .where('r.wallet_id', '=', wallet.id)
      .where('r.status', 'in', ['PENDING_CHALLENGE', 'CHALLENGE_PASSED', 'AWAITING_SIGNATURE', 'SUBMITTED'])
      .orderBy('r.created_at', 'desc')
      .execute();
    return {
      entries: entries.map(entryView),
      requests: requests.map((r) =>
        requestView(r, r.status === 'PENDING_CHALLENGE' ? (r.challenge_expires_at ?? null) : null),
      ),
    };
  }
}
