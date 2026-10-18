// Pérdida de una clave S (P15.T09, runbook docs/runbooks/executor-key-loss.md). Sin S no hay camino asistido (S es
// quien ejecuta y co-firma), así que U + R reemplazan a S por el camino soberano:
//
// 1. Operador (CLI, TOTP): `prepare` crea S′ en el shard de la wallet (PENDING, con su SignerKeyAttestation que la app
//    Recovery verifica con la clave fijada [F-SEC-08]) y arma los dos documentos de intercambio soberano [W-05]:
//    `swapOwner(prev, S, S′)` (nonce N) y `SecurityGuard.updateRoles(U, R, S′)` (nonce N + 1).
// 2. Usuario: Recovery (/sovereign) importa los documentos, R firma, Wallet agrega la firma de U y Recovery transmite
//    (con una wallet externa o cualquier relayer): sin el backend ni el signer.
// 3. Operador (CLI, TOTP): `activate` verifica on-chain con quórum que la S vigente de la Safe es S′ (owners y roles
//    del Guard) y recién entonces S′ queda ACTIVE y la S perdida RETIRED (la sincronización de rotaciones pide su retiro
//    al shard); el gas tank recarga a S′ y la wallet sigue operando en modo asistido.
import type { Kysely } from 'kysely';
import { encodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { iSafeAbi, securityGuardAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { readSafeState, safeConfigDrift } from '../chain/safe-state.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { safeTxToJson, type SafeTxJson } from '../operations/intent.ts';
import type { OperatorCredentials, OperatorService } from '../operators/service.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';

const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Documento de intercambio soberano [W-05] (sin firmas: las agregan R y U en sus apps). */
export interface SovereignSafeTxDocument {
  format: 'mtw-sovereign-safetx';
  version: 1;
  chainId: number;
  safe: Address;
  safeTx: SafeTxJson;
  safeTxHash: Hex;
  action: { type: 'EXECUTOR_REPLACEMENT_SWAP' | 'EXECUTOR_REPLACEMENT_ROLES'; params: Record<string, string> };
  signatures: { signer: Address; role: 'U' | 'R'; signature: Hex }[];
  createdAt: string;
}

export interface ExecutorReplacementPlan {
  walletId: string;
  safe: Address;
  oldExecutor: Address;
  newExecutor: Address;
  shardId: string;
  attestation: string;
  documents: [SovereignSafeTxDocument, SovereignSafeTxDocument];
}

export interface ExecutorReplacementDeps {
  db: Kysely<Database>;
  operators: OperatorService;
  signerKeys: SignerKeyService;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
  emails: EmailOutbox | null;
  metrics?: Metrics;
}

function safeTx(to: Address, data: Hex, nonce: bigint): SafeTx {
  return {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };
}

export class ExecutorReplacementService {
  readonly #d: ExecutorReplacementDeps;

  constructor(deps: ExecutorReplacementDeps) {
    this.#d = deps;
  }

  async #wallet(walletId: string) {
    const wallet = await this.#d.db
      .selectFrom('wallets')
      .select(['id', 'user_id', 'status', 'safe_address'])
      .where('id', '=', walletId)
      .executeTakeFirst();
    if (!wallet) throw new ApiError('NOT_FOUND');
    if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
    return { id: wallet.id, userId: wallet.user_id, safe: bufferToAddress(wallet.safe_address) };
  }

  async #state(safe: Address) {
    const snapshot = this.#d.snapshot();
    const { value } = await this.#d.rpc.readSensitive('executor-replacement', (client, blockNumber) =>
      readSafeState(client, blockNumber, snapshot, safe),
    );
    return value;
  }

  /** Paso 1 (operador): S′ en el shard de la wallet y los dos documentos soberanos para U + R. */
  async prepare(input: { walletId: string; operator: OperatorCredentials }): Promise<ExecutorReplacementPlan> {
    // Primero el operador (TOTP): crear S′ en el shard es un efecto fuera de la base.
    const operator = await this.#d.operators.verify(input.operator);
    const wallet = await this.#wallet(input.walletId);
    const state = await this.#state(wallet.safe);
    const current = await this.#d.signerKeys.activeKey(wallet.id);
    if (!current || !isAddressEqual(current.address, state.roles.executor)) {
      throw new ApiError('CONFLICT', {
        detail: 'la S registrada no es la S vigente de la Safe: revisá la wallet a mano',
      });
    }
    // Una S′ preparada antes y nunca instalada se reutiliza (no se acumulan claves).
    const pending = await this.#d.db
      .selectFrom('signer_keys')
      .select(['address', 'attestation', 'shard_id'])
      .where('wallet_id', '=', wallet.id)
      .where('status', '=', 'PENDING')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const created =
      pending !== undefined && pending.attestation !== null
        ? { address: bufferToAddress(pending.address), attestation: pending.attestation, shardId: pending.shard_id }
        : await this.#d.signerKeys.createRotationKey(wallet.id);
    if (created.attestation === null) throw new Error('el signer creó la S nueva sin atestación');
    const newExecutor = getAddress(created.address);
    const snapshot = this.#d.snapshot();
    const index = state.owners.findIndex((o) => isAddressEqual(o, state.roles.executor));
    const prev = index <= 0 ? SENTINEL : (state.owners[index - 1] ?? SENTINEL);
    const nonce = BigInt(state.nonce);
    const createdAt = new Date().toISOString();
    const document = (
      to: Address,
      data: Hex,
      txNonce: bigint,
      action: SovereignSafeTxDocument['action'],
    ): SovereignSafeTxDocument => {
      const tx = safeTx(to, data, txNonce);
      return {
        format: 'mtw-sovereign-safetx',
        version: 1,
        chainId: snapshot.chainId,
        safe: wallet.safe,
        safeTx: safeTxToJson(tx),
        safeTxHash: safeTxHash(snapshot.chainId, wallet.safe, tx),
        action,
        signatures: [],
        createdAt,
      };
    };
    const documents: [SovereignSafeTxDocument, SovereignSafeTxDocument] = [
      document(
        wallet.safe,
        encodeFunctionData({
          abi: iSafeAbi,
          functionName: 'swapOwner',
          args: [prev, state.roles.executor, newExecutor],
        }),
        nonce,
        {
          type: 'EXECUTOR_REPLACEMENT_SWAP',
          params: { prevOwner: prev, oldExecutor: state.roles.executor, newExecutor },
        },
      ),
      document(
        state.guard,
        encodeFunctionData({
          abi: securityGuardAbi,
          functionName: 'updateRoles',
          args: [state.roles.userKey, state.roles.recoveryKey, newExecutor],
        }),
        nonce + 1n,
        {
          type: 'EXECUTOR_REPLACEMENT_ROLES',
          params: { userKey: state.roles.userKey, recoveryKey: state.roles.recoveryKey, executor: newExecutor },
        },
      ),
    ];
    await withTransaction(
      this.#d.db,
      (trx) =>
        this.#d.audit.append(trx, {
          actorType: 'OPERATOR',
          actorId: operator.id,
          userId: wallet.userId,
          walletId: wallet.id,
          eventType: 'EXECUTOR_REPLACEMENT_PREPARED',
          targetType: 'wallet',
          targetId: wallet.id,
          payload: {
            operator: operator.email,
            oldExecutor: state.roles.executor,
            newExecutor,
            shardId: created.shardId,
            safeTxHashes: documents.map((d) => d.safeTxHash),
          },
        }),
      { auditLock: true },
    );
    return {
      walletId: wallet.id,
      safe: wallet.safe,
      oldExecutor: state.roles.executor,
      newExecutor,
      shardId: created.shardId,
      attestation: created.attestation,
      documents,
    };
  }

  /** Paso 3 (operador): con S′ instalada on-chain por U + R, S′ ACTIVE y la S perdida RETIRED. */
  async activate(input: {
    walletId: string;
    operator: OperatorCredentials;
  }): Promise<{ walletId: string; safe: Address; oldExecutor: Address; newExecutor: Address }> {
    const operator = await this.#d.operators.verify(input.operator);
    const wallet = await this.#wallet(input.walletId);
    const pending = await this.#d.db
      .selectFrom('signer_keys')
      .select(['id', 'address', 'attestation'])
      .where('wallet_id', '=', wallet.id)
      .where('status', '=', 'PENDING')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (pending === undefined || pending.attestation === null) {
      throw new ApiError('CONFLICT', { detail: 'no hay una S nueva preparada para esta wallet' });
    }
    const newExecutor = bufferToAddress(pending.address);
    const state = await this.#state(wallet.safe);
    const installed =
      isAddressEqual(state.roles.executor, newExecutor) && state.owners.some((o) => isAddressEqual(o, newExecutor));
    if (!installed) {
      throw new ApiError('CONFLICT', {
        detail: 'la S de la Safe todavía no es la nueva: U y R tienen que ejecutar los dos documentos soberanos',
      });
    }
    const drift = safeConfigDrift(state, this.#d.snapshot());
    if (drift.length > 0) {
      throw new ApiError('SAFE_CONFIG_MODIFIED', { detail: `la Safe no quedó en modo asistido: ${drift.join(',')}` });
    }
    return withTransaction(
      this.#d.db,
      async (trx) => {
        const now = new Date();
        const old = await trx
          .updateTable('signer_keys')
          .set({ status: 'RETIRED', retired_at: now })
          .where('wallet_id', '=', wallet.id)
          .where('status', '=', 'ACTIVE')
          .returning('address')
          .executeTakeFirst();
        if (!old) throw new ApiError('CONFLICT', { detail: 'la wallet no tiene una S activa registrada' });
        const activated = await trx
          .updateTable('signer_keys')
          .set({ status: 'ACTIVE' })
          .where('id', '=', pending.id)
          .where('status', '=', 'PENDING')
          .returning('id')
          .executeTakeFirst();
        if (!activated) throw new ApiError('CONFLICT', { detail: 'la S nueva cambió de estado' });
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'ROTATED_OUT', deactivated_at: now })
          .where('wallet_id', '=', wallet.id)
          .where('role', '=', 'S')
          .where('status', '=', 'ACTIVE')
          .execute();
        const version = await trx
          .selectFrom('wallet_keys_metadata')
          .select((eb) => eb.fn.max('key_version').as('v'))
          .where('wallet_id', '=', wallet.id)
          .where('role', '=', 'S')
          .executeTakeFirst();
        await trx
          .insertInto('wallet_keys_metadata')
          .values({
            wallet_id: wallet.id,
            role: 'S',
            key_address: addressToBuffer(newExecutor),
            key_version: (version?.v ?? 0) + 1,
            status: 'ACTIVE',
            source: 'SIGNER_SHARD',
            activated_at: now,
          })
          .execute();
        const oldExecutor = bufferToAddress(old.address);
        const occurredAt = now.toISOString();
        await this.#d.audit.append(trx, {
          actorType: 'OPERATOR',
          actorId: operator.id,
          userId: wallet.userId,
          walletId: wallet.id,
          eventType: 'EXECUTOR_REPLACED',
          targetType: 'wallet',
          targetId: wallet.id,
          payload: { operator: operator.email, oldExecutor, newExecutor, sovereign: true },
        });
        const params = { role: 'S' as const, oldKey: oldExecutor, newKey: newExecutor, safe: wallet.safe, occurredAt };
        const created = await notify(
          trx,
          {
            userId: wallet.userId,
            walletId: wallet.id,
            type: 'EXECUTOR_REPLACED',
            payload: params,
            dedupeKey: `EXECUTOR_REPLACED:${newExecutor}`,
          },
          this.#d.metrics,
        );
        if (created && this.#d.emails !== null) {
          const user = await trx
            .selectFrom('users')
            .select(['email', 'locale', 'time_zone'])
            .where('id', '=', wallet.userId)
            .executeTakeFirstOrThrow();
          await this.#d.emails.enqueue(trx, {
            to: user.email,
            template: 'rotation-executed',
            params,
            locale: user.locale,
            timeZone: user.time_zone,
            product: 'Recovery',
          });
        }
        return { walletId: wallet.id, safe: wallet.safe, oldExecutor, newExecutor };
      },
      { auditLock: true },
    );
  }
}
