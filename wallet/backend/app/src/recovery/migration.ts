// Migración excepcional (P15.T06, ADR-026, runbook docs/runbooks/exceptional-migration.md): una credencial
// comprometida (U o R) veta cada rotación con su cancelación individual, así que los fondos se mueven a una Safe nueva
// donde la credencial sana conserva su rol.
//
// 1. Operadores (CLI, TOTP): un operador abre el caso (credencial sana y motivo) y OTRO lo aprueba → `operator_actions`
//    (append-only, approver_1 ≠ approver_2), caso APPROVED y la wallet vieja MIGRATING (la plataforma deja de
//    co-firmar todo salvo la migración). Email y notificación al usuario.
// 2. Usuario: onboarding de la wallet nueva (`migrated_from_wallet_id`) con la credencial sana reutilizada en su mismo
//    rol y una credencial nueva en lugar de la comprometida; deploy por la factory.
// 3. Governance Safe: `proposeMigrationAuthorization(vieja, nueva)` en el PolicyRegistry, 24 h (los guardianes pueden
//    cancelarla) y `activateChange`.
// 4. `POST /wallets/{id}/migration/prepare` (sesión de la credencial sana sobre la wallet vieja): con el caso aprobado,
//    la Safe nueva ACTIVE y la autorización on-chain activa, un `MIGRATION_TRANSFER` por token con el saldo completo
//    (exento del límite de 24 h), firmado por la credencial sana y ejecutado por S; el Guard exige que la Safe destino
//    tenga la misma clave en ese rol ([C-GRD-06]).
// 5. Sincronización del worker: sin saldo en la Safe vieja y sin operaciones en curso → MIGRATED, caso COMPLETED.
import type { Kysely, Selectable, Transaction } from 'kysely';
import { encodeFunctionData, getAddress, isAddressEqual, type Abi, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { policyRegistryAbi } from '../chain/abis/index.ts';
import { RpcQuorumError, type RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { readSafeState } from '../chain/safe-state.ts';
import type { Database, MigrationCasesTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import type { PreparedOperation } from '../operations/intent.ts';
import { roleForScope, type OperationActor, type OperationService } from '../operations/service.ts';
import { isUuid, walletForActor } from '../operations/wallet-access.ts';
import type { OperatorCredentials, OperatorService } from '../operators/service.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

type CaseRow = Selectable<MigrationCasesTable>;

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

/** Estados de una operación que todavía puede ejecutarse (la migración no termina mientras haya alguna). */
const IN_FLIGHT = [
  'USER_SIGNED',
  'QUEUED',
  'VALIDATING',
  'READY',
  'SUBMITTED',
  'MINED',
  'FAILED_RETRYABLE',
  'REORGED',
  'CANCEL_REQUESTED',
] as const;

export interface MigrationCaseView {
  id: string;
  oldWalletId: string;
  newWalletId: string | null;
  userId: string;
  healthyRole: 'U' | 'R';
  reason: string;
  status: CaseRow['status'];
  requestedBy: string;
  approvalActionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MigrationPrepared {
  case: MigrationCaseView;
  destination: { walletId: string; safe: Address };
  operations: PreparedOperation[];
}

function view(row: CaseRow): MigrationCaseView {
  return {
    id: row.id,
    oldWalletId: row.old_wallet_id,
    newWalletId: row.new_wallet_id,
    userId: row.user_id,
    healthyRole: row.healthy_role,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    approvalActionId: row.approval_action_id,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

const HEALTHY_NAMES = {
  U: 'tu clave de usuario (U)',
  R: 'tu clave de recuperación (R)',
} as const;

async function caseView(db: Kysely<Database>, caseId: string): Promise<MigrationCaseView> {
  if (!isUuid(caseId)) throw new ApiError('NOT_FOUND');
  const row = await db.selectFrom('migration_cases').selectAll().where('id', '=', caseId).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return view(row);
}

export interface MigrationCasesDeps {
  db: Kysely<Database>;
  operators: OperatorService;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  metrics?: Metrics;
}

/** Lado de operadores de la migración (CLI): abrir, aprobar (doble aprobación) y cancelar casos. */
export class MigrationCases {
  readonly #d: MigrationCasesDeps;

  constructor(deps: MigrationCasesDeps) {
    this.#d = deps;
  }

  async view(caseId: string): Promise<MigrationCaseView> {
    return caseView(this.#d.db, caseId);
  }

  /** Operador 1 (CLI): abre el caso tras la verificación humana reforzada (credencial sana y motivo). */
  async request(input: {
    walletId: string;
    healthyRole: 'U' | 'R';
    reason: string;
    operator: OperatorCredentials;
  }): Promise<MigrationCaseView> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) {
      throw new ApiError('VALIDATION_FAILED', { detail: 'el motivo tiene que tener entre 10 y 500 caracteres' });
    }
    return this.#d.operators.run(input.operator, async (trx, operator) => {
      const wallet = await trx
        .selectFrom('wallets')
        .select(['id', 'user_id', 'status', 'safe_address'])
        .where('id', '=', input.walletId)
        .forUpdate()
        .executeTakeFirst();
      if (!wallet) throw new ApiError('NOT_FOUND');
      if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
      const open = await trx
        .selectFrom('migration_cases')
        .select('id')
        .where('old_wallet_id', '=', wallet.id)
        .where('status', 'in', ['REQUESTED', 'APPROVED'])
        .executeTakeFirst();
      if (open) throw new ApiError('CONFLICT', { detail: `la wallet ya tiene un caso abierto (${open.id})` });
      const row = await trx
        .insertInto('migration_cases')
        .values({
          old_wallet_id: wallet.id,
          user_id: wallet.user_id,
          healthy_role: input.healthyRole,
          reason,
          status: 'REQUESTED',
          requested_by: operator.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.#d.audit.append(trx, {
        actorType: 'OPERATOR',
        actorId: operator.id,
        userId: wallet.user_id,
        walletId: wallet.id,
        eventType: 'MIGRATION_CASE_REQUESTED',
        targetType: 'migration_case',
        targetId: row.id,
        payload: { healthyRole: input.healthyRole, reason, operator: operator.email },
      });
      return view(row);
    });
  }

  /**
   * Operador 2 (CLI, distinto del que abrió el caso): doble aprobación en `operator_actions`, caso APPROVED y la
   * wallet vieja MIGRATING; el usuario recibe email y notificación.
   */
  async approve(input: { caseId: string; operator: OperatorCredentials }): Promise<MigrationCaseView> {
    if (!isUuid(input.caseId)) throw new ApiError('NOT_FOUND');
    return this.#d.operators.run(input.operator, async (trx, operator) => {
      const row = await trx
        .selectFrom('migration_cases')
        .selectAll()
        .where('id', '=', input.caseId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      if (row.status !== 'REQUESTED') throw new ApiError('CONFLICT', { detail: `el caso está ${row.status}` });
      if (row.requested_by === operator.id) {
        throw new ApiError('CONFLICT', { detail: 'la aprobación tiene que ser de otro operador (doble aprobación)' });
      }
      const wallet = await trx
        .selectFrom('wallets')
        .select(['id', 'status', 'safe_address'])
        .where('id', '=', row.old_wallet_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
      const safe = bufferToAddress(wallet.safe_address);
      const action = await trx
        .insertInto('operator_actions')
        .values({
          action_type: 'EXCEPTIONAL_MIGRATION',
          wallet_id: wallet.id,
          payload: JSON.stringify({ caseId: row.id, healthyRole: row.healthy_role, reason: row.reason, safe }),
          approver_1: row.requested_by,
          approver_2: operator.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const approved = await trx
        .updateTable('migration_cases')
        .set({ status: 'APPROVED', approval_action_id: action.id })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.updateTable('wallets').set({ status: 'MIGRATING' }).where('id', '=', wallet.id).execute();
      await this.#d.audit.append(trx, {
        actorType: 'OPERATOR',
        actorId: operator.id,
        userId: row.user_id,
        walletId: wallet.id,
        eventType: 'OPERATOR_ACTION_RECORDED',
        targetType: 'operator_action',
        targetId: action.id,
        payload: { actionType: 'EXCEPTIONAL_MIGRATION', approver1: row.requested_by, approver2: operator.id },
      });
      await this.#d.audit.append(trx, {
        actorType: 'OPERATOR',
        actorId: operator.id,
        userId: row.user_id,
        walletId: wallet.id,
        eventType: 'MIGRATION_CASE_APPROVED',
        targetType: 'migration_case',
        targetId: row.id,
        payload: { approvalActionId: action.id, healthyRole: row.healthy_role, safe },
      });
      await this.#tell(trx, row.user_id, wallet.id, 'MIGRATION_APPROVED', 'migration-approved', {
        safe,
        healthy: HEALTHY_NAMES[row.healthy_role],
        occurredAt: new Date().toISOString(),
      });
      return view(approved);
    });
  }

  /** Cancela un caso todavía sin Safe nueva desplegada: la wallet vieja vuelve a ACTIVE y la nueva queda ABANDONED. */
  async cancel(input: { caseId: string; operator: OperatorCredentials }): Promise<MigrationCaseView> {
    if (!isUuid(input.caseId)) throw new ApiError('NOT_FOUND');
    return this.#d.operators.run(input.operator, async (trx, operator) => {
      const row = await trx
        .selectFrom('migration_cases')
        .selectAll()
        .where('id', '=', input.caseId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      if (row.status !== 'REQUESTED' && row.status !== 'APPROVED') {
        throw new ApiError('CONFLICT', { detail: `el caso está ${row.status}` });
      }
      if (row.new_wallet_id !== null) {
        const fresh = await trx
          .selectFrom('wallets')
          .select('status')
          .where('id', '=', row.new_wallet_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (fresh.status !== 'CREATING') {
          throw new ApiError('CONFLICT', { detail: `la Safe nueva ya está ${fresh.status}: completá la migración` });
        }
        await trx.updateTable('wallets').set({ status: 'ABANDONED' }).where('id', '=', row.new_wallet_id).execute();
      }
      if (row.status === 'APPROVED') {
        await trx
          .updateTable('wallets')
          .set({ status: 'ACTIVE' })
          .where('id', '=', row.old_wallet_id)
          .where('status', '=', 'MIGRATING')
          .execute();
      }
      const cancelled = await trx
        .updateTable('migration_cases')
        .set({ status: 'CANCELLED' })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.#d.audit.append(trx, {
        actorType: 'OPERATOR',
        actorId: operator.id,
        userId: row.user_id,
        walletId: row.old_wallet_id,
        eventType: 'MIGRATION_CASE_CANCELLED',
        targetType: 'migration_case',
        targetId: row.id,
        payload: { previousStatus: row.status, newWalletId: row.new_wallet_id },
      });
      return view(cancelled);
    });
  }

  async #tell(
    trx: Transaction<Database>,
    userId: string,
    walletId: string,
    type: 'MIGRATION_APPROVED' | 'MIGRATION_COMPLETED',
    template: 'migration-approved' | 'migration-completed',
    params: Record<string, string>,
  ): Promise<void> {
    await tell(trx, this.#d, { userId, walletId, type, template, params });
  }
}

export interface MigrationServiceDeps {
  db: Kysely<Database>;
  operations: OperationService;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
}

/** Lado del usuario (API): el MIGRATION_TRANSFER firmado por la credencial sana. */
export class MigrationService {
  readonly #d: MigrationServiceDeps;

  constructor(deps: MigrationServiceDeps) {
    this.#d = deps;
  }

  async view(caseId: string): Promise<MigrationCaseView> {
    return caseView(this.#d.db, caseId);
  }

  /**
   * POST /wallets/{id}/migration/prepare (sesión de la credencial sana sobre la wallet vieja): un MIGRATION_TRANSFER
   * por token con saldo, por el saldo completo, hacia la Safe nueva autorizada on-chain.
   */
  async prepare(actor: OperationActor, walletId: string): Promise<MigrationPrepared> {
    const signer = roleForScope(actor.session.claims.scope);
    const wallet = await walletForActor(this.#d.db, actor, walletId, { allowMigrating: true });
    const row = await this.#d.db
      .selectFrom('migration_cases')
      .selectAll()
      .where('old_wallet_id', '=', wallet.id)
      .where('status', '=', 'APPROVED')
      .executeTakeFirst();
    if (!row)
      throw new ApiError('CONFLICT', { detail: 'la wallet no tiene una migración aprobada por los operadores' });
    if (row.healthy_role !== signer) {
      throw new ApiError('SCOPE_NOT_ALLOWED', {
        detail: `la migración la firma la credencial sana (${row.healthy_role}), no ${signer}`,
      });
    }
    if (row.new_wallet_id === null) throw new ApiError('CONFLICT', { detail: 'todavía no se creó la Safe nueva' });
    const fresh = await this.#d.db
      .selectFrom('wallets')
      .select(['id', 'status', 'safe_address'])
      .where('id', '=', row.new_wallet_id)
      .executeTakeFirstOrThrow();
    if (fresh.status !== 'ACTIVE' || fresh.safe_address === null) {
      throw new ApiError('CONFLICT', { detail: 'la Safe nueva todavía no está activa' });
    }
    const destination = bufferToAddress(fresh.safe_address);
    const snapshot = this.#d.snapshot();
    const { value } = await this.#d.rpc.readSensitive('migration-prepare', async (client, blockNumber) => {
      const [authorized, target, usdc, usdt] = await Promise.all([
        client.readContract({
          address: snapshot.contracts.policyRegistry,
          abi: policyRegistryAbi,
          functionName: 'isMigrationAuthorized',
          args: [wallet.safe, destination],
          blockNumber,
        }),
        readSafeState(client, blockNumber, snapshot, destination),
        client.readContract({
          address: snapshot.tokens.USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [wallet.safe],
          blockNumber,
        }),
        client.readContract({
          address: snapshot.tokens.USDT,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [wallet.safe],
          blockNumber,
        }),
      ]);
      const source = await readSafeState(client, blockNumber, snapshot, wallet.safe);
      return {
        authorized,
        sameKey:
          signer === 'U'
            ? isAddressEqual(target.roles.userKey, source.roles.userKey)
            : isAddressEqual(target.roles.recoveryKey, source.roles.recoveryKey),
        balances: { USDC: usdc.toString(), USDT: usdt.toString() },
      };
    });
    if (!value.authorized) {
      throw new ApiError('CONFLICT', {
        detail: 'la autorización on-chain de la migración todavía no está activa en el PolicyRegistry (24 h)',
      });
    }
    if (!value.sameKey) {
      throw new ApiError('CONFLICT', { detail: `la Safe nueva no tiene la misma clave ${signer} que la vieja` });
    }
    const operations: PreparedOperation[] = [];
    for (const token of ['USDC', 'USDT'] as const) {
      const amount = BigInt(value.balances[token]);
      if (amount === 0n) continue;
      operations.push(
        await this.#d.operations.prepare(actor, {
          walletId: wallet.id,
          operationType: 'MIGRATION_TRANSFER',
          call: {
            to: snapshot.tokens[token],
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, amount] }),
          },
        }),
      );
    }
    if (operations.length === 0) {
      throw new ApiError('CONFLICT', { detail: 'la Safe vieja no tiene saldo para migrar' });
    }
    await withTransaction(
      this.#d.db,
      (trx) =>
        this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: wallet.id,
          sessionId: actor.session.claims.sessionId,
          eventType: 'MIGRATION_TRANSFER_PREPARED',
          targetType: 'migration_case',
          targetId: row.id,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: {
            signer,
            destination,
            operations: operations.map((o) => ({
              id: o.operationId,
              token: o.decoded.token,
              amount: o.decoded.amount,
            })),
          },
        }),
      { auditLock: true },
    );
    return { case: view(row), destination: { walletId: fresh.id, safe: getAddress(destination) }, operations };
  }
}

async function tell(
  trx: Transaction<Database>,
  deps: { emails: EmailOutbox | null; metrics?: Metrics | undefined },
  input: {
    userId: string;
    walletId: string;
    type: 'MIGRATION_APPROVED' | 'MIGRATION_COMPLETED';
    template: 'migration-approved' | 'migration-completed';
    params: Record<string, string>;
  },
): Promise<void> {
  const created = await notify(
    trx,
    {
      userId: input.userId,
      walletId: input.walletId,
      type: input.type,
      payload: input.params,
      dedupeKey: `${input.type}:${input.walletId}`,
    },
    deps.metrics,
  );
  if (!created || deps.emails === null) return;
  const user = await trx
    .selectFrom('users')
    .select(['email', 'locale', 'time_zone'])
    .where('id', '=', input.userId)
    .executeTakeFirstOrThrow();
  if (input.template === 'migration-approved') {
    await deps.emails.enqueue(trx, {
      to: user.email,
      template: 'migration-approved',
      params: {
        safe: input.params.safe ?? '',
        healthy: input.params.healthy ?? '',
        occurredAt: input.params.occurredAt ?? '',
      },
      locale: user.locale,
      timeZone: user.time_zone,
      product: 'Wallet',
    });
  } else {
    await deps.emails.enqueue(trx, {
      to: user.email,
      template: 'migration-completed',
      params: {
        oldSafe: input.params.oldSafe ?? '',
        newSafe: input.params.newSafe ?? '',
        occurredAt: input.params.occurredAt ?? '',
      },
      locale: user.locale,
      timeZone: user.time_zone,
      product: 'Wallet',
    });
  }
}

/**
 * Cierre de las migraciones en el worker: caso APPROVED con la Safe nueva ACTIVE, la vieja sin saldo de los tokens
 * soportados (lectura con quórum) y sin operaciones en curso → wallet vieja MIGRATED y caso COMPLETED.
 */
export interface MigrationSyncDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  logger: Logger;
  metrics?: Metrics;
}

export class MigrationSync {
  readonly #d: MigrationSyncDeps;

  constructor(deps: MigrationSyncDeps) {
    this.#d = deps;
  }

  async runOnce(): Promise<{ completed: number }> {
    const cases = await this.#d.db
      .selectFrom('migration_cases as c')
      .innerJoin('wallets as old', 'old.id', 'c.old_wallet_id')
      .innerJoin('wallets as fresh', 'fresh.id', 'c.new_wallet_id')
      .select([
        'c.id',
        'c.old_wallet_id',
        'c.new_wallet_id',
        'c.user_id',
        'old.safe_address as old_safe',
        'fresh.safe_address as new_safe',
      ])
      .where('c.status', '=', 'APPROVED')
      .where('old.status', '=', 'MIGRATING')
      .where('fresh.status', '=', 'ACTIVE')
      .limit(50)
      .execute();
    let completed = 0;
    for (const row of cases) {
      if (row.old_safe === null || row.new_safe === null || row.new_wallet_id === null) continue;
      const oldSafe = bufferToAddress(row.old_safe);
      const inFlight = await this.#d.db
        .selectFrom('wallet_operations')
        .select('id')
        .where('wallet_id', '=', row.old_wallet_id)
        .where('status', 'in', IN_FLIGHT)
        .executeTakeFirst();
      if (inFlight) continue;
      let empty: boolean;
      try {
        const snapshot = this.#d.snapshot();
        const { value } = await this.#d.rpc.readSensitive('migration-balances', async (client, blockNumber) => {
          const balances = await Promise.all(
            [snapshot.tokens.USDC, snapshot.tokens.USDT].map((token) =>
              client.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [oldSafe],
                blockNumber,
              }),
            ),
          );
          return balances.map((b) => b.toString());
        });
        empty = value.every((b) => b === '0');
      } catch (error) {
        if (!(error instanceof RpcQuorumError)) throw error;
        this.#d.logger.warn({ code: error.code }, 'cierre de migración sin quórum: se reintenta');
        continue;
      }
      if (!empty) continue;
      const done = await withTransaction(
        this.#d.db,
        async (trx) => {
          const updated = await trx
            .updateTable('migration_cases')
            .set({ status: 'COMPLETED', completed_at: new Date() })
            .where('id', '=', row.id)
            .where('status', '=', 'APPROVED')
            .returning('id')
            .executeTakeFirst();
          if (!updated) return false;
          await trx
            .updateTable('wallets')
            .set({ status: 'MIGRATED' })
            .where('id', '=', row.old_wallet_id)
            .where('status', '=', 'MIGRATING')
            .execute();
          const newSafe = bufferToAddress(row.new_safe ?? Buffer.alloc(20));
          await this.#d.audit.append(trx, {
            actorType: 'SYSTEM',
            actorId: 'migration-sync',
            userId: row.user_id,
            walletId: row.old_wallet_id,
            eventType: 'MIGRATION_COMPLETED',
            targetType: 'migration_case',
            targetId: row.id,
            payload: { oldSafe, newSafe, newWalletId: row.new_wallet_id },
          });
          await tell(trx, this.#d, {
            userId: row.user_id,
            walletId: row.old_wallet_id,
            type: 'MIGRATION_COMPLETED',
            template: 'migration-completed',
            params: { oldSafe, newSafe, occurredAt: new Date().toISOString() },
          });
          return true;
        },
        { auditLock: true },
      );
      if (done) completed++;
    }
    return { completed };
  }
}
