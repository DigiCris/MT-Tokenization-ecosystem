// Rotación de S pedida por la plataforma (P18.T09.b; playbooks de P26.T16): migración de la clave a otro shard o a un
// HSM, posible compromiso del host del signer o mantenimiento. S sigue disponible, así que la rotación va por el
// timelock con la firma del usuario: el operador (CLI, TOTP) deja un borrador DRAFT de la rotación de S con el motivo y
// la S′ ya creada por el signer (en el shard de la wallet o en el indicado), con su SignerKeyAttestation que la app
// verifica con la clave fijada [F-SEC-08]; el usuario recibe un email y la notificación EXECUTOR_ROTATION_REQUESTED.
// La propuesta la firma U (o R) desde su app con POST /wallets/{id}/rotations y role S, que toma este borrador; el
// signer sólo co-firma la rotación hacia una S que él creó para esa wallet.
import type { Kysely } from 'kysely';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { rotationTimelockAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { readSafeState } from '../chain/safe-state.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import { notify } from '../notifications/notify.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OperatorCredentials, OperatorService } from '../operators/service.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';
import { KIND_OF_ROLE, LIVE_STATUSES } from './service.ts';

export const EXECUTOR_ROTATION_REASONS = ['SHARD_MIGRATION', 'HSM_MIGRATION', 'KEY_COMPROMISE', 'MAINTENANCE'] as const;
export type ExecutorRotationReason = (typeof EXECUTOR_ROTATION_REASONS)[number];

export interface ExecutorRotationRequestDeps {
  db: Kysely<Database>;
  operators: OperatorService;
  signerKeys: SignerKeyService;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  metrics?: Metrics;
}

export interface ExecutorRotationRequest {
  rotationId: string;
  walletId: string;
  safe: Address;
  oldExecutor: Address;
  newExecutor: Address;
  shardId: string;
  reason: ExecutorRotationReason;
  /** false: ya había un pedido abierto para la wallet y se devuelve ese (idempotente). */
  created: boolean;
}

export class ExecutorRotationRequests {
  readonly #d: ExecutorRotationRequestDeps;

  constructor(deps: ExecutorRotationRequestDeps) {
    this.#d = deps;
  }

  async request(input: {
    walletId: string;
    reason: ExecutorRotationReason;
    toShard?: string;
    operator: OperatorCredentials;
  }): Promise<ExecutorRotationRequest> {
    if (!(EXECUTOR_ROTATION_REASONS as readonly string[]).includes(input.reason)) {
      throw new ApiError('VALIDATION_FAILED', { detail: `motivo desconocido: ${input.reason}` });
    }
    // Primero el operador (TOTP): crear S′ en un shard es un efecto fuera de la base.
    const operator = await this.#d.operators.verify(input.operator);
    const wallet = await this.#d.db
      .selectFrom('wallets')
      .select(['id', 'user_id', 'status', 'safe_address'])
      .where('id', '=', input.walletId)
      .executeTakeFirst();
    if (!wallet) throw new ApiError('NOT_FOUND');
    if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
    const safe = bufferToAddress(wallet.safe_address);
    const open = await this.#d.db
      .selectFrom('rotation_requests')
      .select(['id', 'old_key', 'new_key', 'request_reason'])
      .where('wallet_id', '=', wallet.id)
      .where('role', '=', 'S')
      .where('status', '=', 'DRAFT')
      .executeTakeFirst();
    if (open) {
      const newExecutor = bufferToAddress(open.new_key);
      const key = await this.#d.db
        .selectFrom('signer_keys')
        .select('shard_id')
        .where('wallet_id', '=', wallet.id)
        .where('address', '=', addressToBuffer(newExecutor))
        .executeTakeFirstOrThrow();
      return {
        rotationId: open.id,
        walletId: wallet.id,
        safe,
        oldExecutor: bufferToAddress(open.old_key),
        newExecutor,
        shardId: key.shard_id,
        reason: open.request_reason ?? input.reason,
        created: false,
      };
    }
    const live = await this.#d.db
      .selectFrom('rotation_requests')
      .select('id')
      .where('wallet_id', '=', wallet.id)
      .where('role', '=', 'S')
      .where('status', 'in', LIVE_STATUSES)
      .executeTakeFirst();
    if (live) throw new ApiError('CONFLICT', { detail: 'ya hay una rotación de S en curso para esta wallet' });

    const snapshot = this.#d.snapshot();
    const { value } = await this.#d.rpc.readSensitive('executor-rotation-request', async (client, blockNumber) => {
      const state = await readSafeState(client, blockNumber, snapshot, safe);
      const active = await client.readContract({
        address: state.timelock,
        abi: rotationTimelockAbi,
        functionName: 'activeProposal',
        args: [safe, KIND_OF_ROLE.S],
        blockNumber,
      });
      return { state, active };
    });
    if (!/^0x0{64}$/.test(value.active)) {
      throw new ApiError('CONFLICT', { detail: 'ya hay una propuesta de rotación de S pendiente en el timelock' });
    }
    const current = await this.#d.signerKeys.activeKey(wallet.id);
    if (!current || !isAddressEqual(current.address, value.state.roles.executor)) {
      throw new ApiError('CONFLICT', {
        detail: 'la S registrada no es la S vigente de la Safe: revisá la wallet a mano',
      });
    }
    // Una S′ creada antes y nunca instalada se reutiliza si está en el shard pedido (no se acumulan claves).
    const pending = await this.#d.db
      .selectFrom('signer_keys')
      .select(['address', 'attestation', 'shard_id'])
      .where('wallet_id', '=', wallet.id)
      .where('status', '=', 'PENDING')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const reusable =
      pending !== undefined &&
      pending.attestation !== null &&
      (input.toShard === undefined || pending.shard_id === input.toShard);
    const created = reusable
      ? { address: bufferToAddress(pending.address), attestation: pending.attestation, shardId: pending.shard_id }
      : await this.#d.signerKeys.createRotationKey(wallet.id, input.toShard);
    if (created.attestation === null) throw new Error('el signer creó la S nueva sin atestación');
    const newExecutor = getAddress(created.address);
    const oldExecutor = value.state.roles.executor;

    return withTransaction(
      this.#d.db,
      async (trx) => {
        const row = await trx
          .insertInto('rotation_requests')
          .values({
            wallet_id: wallet.id,
            role: 'S',
            old_key: addressToBuffer(oldExecutor),
            new_key: addressToBuffer(newExecutor),
            // Lo reemplaza quien firme la propuesta (U en Wallet o R en Recovery).
            initiated_by: 'U',
            status: 'DRAFT',
            new_key_attestation: created.attestation,
            request_reason: input.reason,
            timelock: addressToBuffer(value.state.timelock),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const occurredAt = new Date().toISOString();
        await this.#d.audit.append(trx, {
          actorType: 'OPERATOR',
          actorId: operator.id,
          userId: wallet.user_id,
          walletId: wallet.id,
          eventType: 'EXECUTOR_ROTATION_REQUESTED',
          targetType: 'rotation',
          targetId: row.id,
          payload: {
            operator: operator.email,
            reason: input.reason,
            oldExecutor,
            newExecutor,
            shardId: created.shardId,
          },
        });
        const params = { reason: input.reason, oldKey: oldExecutor, newKey: newExecutor, safe, occurredAt };
        const notified = await notify(
          trx,
          {
            userId: wallet.user_id,
            walletId: wallet.id,
            type: 'EXECUTOR_ROTATION_REQUESTED',
            payload: { rotationId: row.id, ...params },
            dedupeKey: `EXECUTOR_ROTATION_REQUESTED:${row.id}`,
          },
          this.#d.metrics,
        );
        if (notified && this.#d.emails !== null) {
          const user = await trx
            .selectFrom('users')
            .select(['email', 'locale', 'time_zone'])
            .where('id', '=', wallet.user_id)
            .executeTakeFirstOrThrow();
          await this.#d.emails.enqueue(trx, {
            to: user.email,
            template: 'executor-rotation-requested',
            params,
            locale: user.locale,
            timeZone: user.time_zone,
            product: 'Wallet',
          });
        }
        return {
          rotationId: row.id,
          walletId: wallet.id,
          safe,
          oldExecutor,
          newExecutor,
          shardId: created.shardId,
          reason: input.reason,
          created: true,
        };
      },
      { auditLock: true },
    );
  }
}
