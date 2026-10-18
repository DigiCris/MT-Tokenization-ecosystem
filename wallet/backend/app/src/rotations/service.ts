// Rotaciones asistidas (P15.T01–T03, [C-RTL], [C-GRD-11/12/17], ADR-007): propuesta en el RotationTimelock por SafeTx
// firmada por U o R y co-firmada por S, 48 h de timelock con cancelación individual por U o R (firma EIP-712
// `CancelRotation` que cualquiera puede transmitir; el backend la retransmite por el gas tank) y ejecución
// (`swapOwner` o, para el Guard, `setGuard`/`setModuleGuard`) firmada por U o R y ejecutada por la S vigente.
//
// Quién propone qué ([C-GRD-11], [W-07]): U propone U, R, S, GUARD y MODULE_GUARD; R propone U o S (nunca R ni el
// Guard). La clave nueva nunca la manda el cliente en la propuesta: sale del material ya registrado y verificado —
// U' del flujo U_REPLACEMENT (registro OPAQUE pendiente + KeyAcceptance), R' del enrollment de reemplazo (con su
// KeyAcceptance), S' creada por el signer para esta wallet (con su SignerKeyAttestation) y el sucesor del Guard del
// PolicyRegistry. El estado posterior (propuesta confirmada, madura, cancelada o ejecutada, con sus efectos) lo aplica
// la sincronización del worker desde los eventos on-chain (rotations/sync.ts).
import type { Kysely, Selectable } from 'kysely';
import { encodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { iSafeAbi, policyRegistryAbi, rotationTimelockAbi, securityGuardAbi } from '../chain/abis/index.ts';
import { RotationKind } from '../chain/constants.ts';
import { cancelRotationDigest, timelockDomain } from '../chain/eip712.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { readSafeState, type SafeChainState } from '../chain/safe-state.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Database, RotationRequestsTable, RotationRole } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { PreparedOperation } from '../operations/intent.ts';
import { roleForScope, type OperationActor, type OperationService } from '../operations/service.ts';
import { isUuid, walletForActor, walletOfUser } from '../operations/wallet-access.ts';
import { guardOfTimelock } from '../policy/guards.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';
import type { PolicyFacts } from '../policy/evaluate.ts';
import { isSignerKeyOf, keyAcceptanceValid } from './facts.ts';

type RotationRow = Selectable<RotationRequestsTable>;

export const ROTATION_ROLES = ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'] as const satisfies readonly RotationRole[];
export const ROTATION_STATUSES = [
  'DRAFT',
  'AWAITING_SIGNATURE',
  'PROPOSING',
  'PENDING_TIMELOCK',
  'READY_TO_EXECUTE',
  'EXECUTING',
  'EXECUTED',
  'CANCELLED',
  'FAILED',
] as const satisfies readonly RotationRow['status'][];

/** RotationKind del timelock por rol de rotación. */
export const KIND_OF_ROLE: Readonly<Record<RotationRole, number>> = {
  U: RotationKind.User,
  R: RotationKind.Recovery,
  S: RotationKind.Executor,
  GUARD: RotationKind.Guard,
  MODULE_GUARD: RotationKind.ModuleGuard,
};

/** [C-GRD-11]: qué roles de rotación propone cada firmante. */
const PROPOSABLE: Readonly<Record<'U' | 'R', readonly RotationRole[]>> = {
  U: ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'],
  R: ['U', 'S'],
};

/** Estados en los que la rotación está en curso (una sola por rol, índice único parcial). */
const LIVE_STATUSES: readonly RotationRow['status'][] = [
  'PROPOSING',
  'PENDING_TIMELOCK',
  'READY_TO_EXECUTE',
  'EXECUTING',
];

export interface RotationView {
  id: string;
  walletId: string;
  role: RotationRole;
  oldKey: Address;
  newKey: Address;
  status: RotationRow['status'];
  origin: 'PLATFORM' | 'ONCHAIN';
  initiatedBy: 'U' | 'R' | 'SAFE';
  proposalId: Hex | null;
  executableAt: string | null;
  cancelledBy: 'U' | 'R' | 'SAFE' | null;
  proposeOperationId: string | null;
  executeOperationId: string | null;
  proposedAt: string | null;
  executedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  /** EIP-712 `CancelRotation` a firmar con U o R mientras la propuesta esté pendiente ([C-RTL-03]). */
  cancelTypedData: ReturnType<typeof cancelTypedData> | null;
}

export interface RotationDeps {
  db: Kysely<Database>;
  operations: OperationService;
  signerKeys: SignerKeyService;
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
  audit: AuditWriter;
  outbox: OutboxRepository;
  logger: Logger;
  metrics?: Metrics;
}

/** Estado on-chain para una propuesta: Safe, propuesta activa del rol en el timelock y sucesor del Guard. */
interface ProposalChainContext {
  state: SafeChainState;
  active: Hex;
  successor: Address | null;
}

function cancelTypedData(chainId: number, timelock: Address, proposalId: Hex, safe: Address) {
  return {
    domain: timelockDomain(chainId, timelock),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      CancelRotation: [
        { name: 'proposalId', type: 'bytes32' },
        { name: 'safe', type: 'address' },
      ],
    },
    primaryType: 'CancelRotation' as const,
    message: { proposalId, safe },
  };
}

export class RotationService {
  readonly #d: RotationDeps;

  constructor(deps: RotationDeps) {
    this.#d = deps;
  }

  /** RotationTimelock de la rotación (filas anteriores a P15: el del sistema). */
  #timelockOf(row: Pick<RotationRow, 'timelock'>): Address {
    return row.timelock === null ? this.#d.snapshot().contracts.rotationTimelock : bufferToAddress(row.timelock);
  }

  #view(row: RotationRow, safe: Address | null): RotationView {
    const snapshot = this.#d.snapshot();
    const proposalId = row.proposal_id === null ? null : bufferToHex(row.proposal_id);
    const pending = row.status === 'PENDING_TIMELOCK' || row.status === 'READY_TO_EXECUTE';
    return {
      id: row.id,
      walletId: row.wallet_id,
      role: row.role,
      oldKey: bufferToAddress(row.old_key),
      newKey: bufferToAddress(row.new_key),
      status: row.status,
      origin: row.origin,
      initiatedBy: row.initiated_by,
      proposalId,
      executableAt: row.executable_at?.toISOString() ?? null,
      cancelledBy: row.cancelled_by,
      proposeOperationId: row.propose_operation_id,
      executeOperationId: row.execute_operation_id,
      proposedAt: row.proposed_at?.toISOString() ?? null,
      executedAt: row.executed_at?.toISOString() ?? null,
      failureReason: row.failure_reason,
      createdAt: row.created_at.toISOString(),
      cancelTypedData:
        pending && proposalId !== null && safe !== null
          ? cancelTypedData(snapshot.chainId, this.#timelockOf(row), proposalId, safe)
          : null,
    };
  }

  /** GET /wallets/{id}/rotations (sesión de cuenta). */
  async list(userId: string, walletId: string): Promise<RotationView[]> {
    const wallet = await walletOfUser(this.#d.db, userId, walletId);
    const rows = await this.#d.db
      .selectFrom('rotation_requests')
      .selectAll()
      .where('wallet_id', '=', wallet.id)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => this.#view(r, wallet.safe));
  }

  async #rotationFor(userId: string, rotationId: string): Promise<RotationRow> {
    if (!isUuid(rotationId)) throw new ApiError('NOT_FOUND');
    const row = await this.#d.db
      .selectFrom('rotation_requests as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .selectAll('r')
      .select('w.user_id')
      .where('r.id', '=', rotationId)
      .executeTakeFirst();
    if (row?.user_id !== userId) throw new ApiError('NOT_FOUND');
    return row;
  }

  /** Lecturas on-chain de la propuesta: estado de la Safe, propuesta activa del rol y sucesor del Guard. */
  async #chain(safe: Address, role: RotationRole): Promise<ProposalChainContext> {
    const snapshot = this.#d.snapshot();
    const c = snapshot.contracts;
    const { value } = await this.#d.rpc.readSensitive('rotation-context', async (client, blockNumber) => {
      const state = await readSafeState(client, blockNumber, snapshot, safe);
      // El timelock del Guard que gobierna la Safe ([C-GRD-17]: tras un upgrade, el del sucesor).
      const active = await client.readContract({
        address: state.timelock,
        abi: rotationTimelockAbi,
        functionName: 'activeProposal',
        args: [safe, KIND_OF_ROLE[role]],
        blockNumber,
      });
      let successor: Address | null = null;
      if (role === 'GUARD' || role === 'MODULE_GUARD') {
        successor = await client.readContract({
          address: c.policyRegistry,
          abi: policyRegistryAbi,
          functionName: role === 'GUARD' ? 'successorGuardOf' : 'successorModuleGuardOf',
          args: [role === 'GUARD' ? state.guard : state.moduleGuard],
          blockNumber,
        });
      }
      return { state, active, successor };
    });
    return value;
  }

  /**
   * POST /wallets/{id}/rotations: prepara `RotationTimelock.propose(kind, old, new)` para firmar con U (OPERATIONS)
   * o R (RECOVERY), con la clave nueva ya registrada y verificada para el rol.
   */
  async propose(
    actor: OperationActor,
    walletId: string,
    input: { role: RotationRole },
  ): Promise<{ rotation: RotationView; operation: PreparedOperation }> {
    const proposer = roleForScope(actor.session.claims.scope);
    if (!PROPOSABLE[proposer].includes(input.role)) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: `${proposer} no propone la rotación de ${input.role}` });
    }
    const wallet = await walletForActor(this.#d.db, actor, walletId);
    const live = await this.#d.db
      .selectFrom('rotation_requests')
      .select('status')
      .where('wallet_id', '=', wallet.id)
      .where('role', '=', input.role)
      .where('status', 'in', LIVE_STATUSES)
      .executeTakeFirst();
    if (live) throw new ApiError('CONFLICT', { detail: `ya hay una rotación de ${input.role} en curso` });
    const chain = await this.#chain(wallet.safe, input.role);
    if (!/^0x0{64}$/.test(chain.active)) {
      throw new ApiError('CONFLICT', { detail: 'ya hay una propuesta pendiente en el timelock para ese rol' });
    }
    const roles = chain.state.roles;
    const material = await this.#newKeyMaterial(wallet, input.role, chain);
    const oldValue: Address =
      input.role === 'U'
        ? roles.userKey
        : input.role === 'R'
          ? roles.recoveryKey
          : input.role === 'S'
            ? roles.executor
            : input.role === 'GUARD'
              ? chain.state.guard
              : chain.state.moduleGuard;
    if (isAddressEqual(material.newKey, oldValue))
      throw new ApiError('CONFLICT', { detail: 'la clave nueva es la actual' });
    const prepared = await this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: 'ROTATION_PROPOSE',
      call: {
        to: chain.state.timelock,
        data: encodeFunctionData({
          abi: rotationTimelockAbi,
          functionName: 'propose',
          args: [KIND_OF_ROLE[input.role], oldValue, material.newKey],
        }),
      },
      // Sólo el hecho verificado recién para este rol (KeyAcceptance de U'/R' o S' creada para esta wallet); el del
      // sucesor del Guard lo lee el contexto on-chain. El worker y el signer los vuelven a verificar.
      extraFacts:
        material.keyAcceptance !== null
          ? { keyAcceptanceValid: true }
          : material.attestation !== null
            ? { newKeyIsSignerKey: true }
            : {},
      afterInsert: async (trx, created) => {
        const values = {
          wallet_id: wallet.id,
          role: input.role,
          old_key: addressToBuffer(oldValue),
          new_key: addressToBuffer(material.newKey),
          initiated_by: proposer,
          status: 'AWAITING_SIGNATURE' as const,
          propose_operation_id: created.operationId,
          key_acceptance: material.keyAcceptance === null ? null : JSON.stringify(material.keyAcceptance),
          new_key_attestation: material.attestation,
          opaque_record_id: material.opaqueRecordId,
          enrollment_id: material.enrollmentId,
          timelock: addressToBuffer(chain.state.timelock),
          failure_reason: null,
        };
        let rotationId: string;
        if (material.draftId !== null) {
          const updated = await trx
            .updateTable('rotation_requests')
            .set(values)
            .where('id', '=', material.draftId)
            .where('status', '=', 'DRAFT')
            .returning('id')
            .executeTakeFirst();
          if (!updated) throw new ApiError('CONFLICT', { detail: 'el borrador de la rotación cambió' });
          rotationId = updated.id;
        } else {
          rotationId = (
            await trx.insertInto('rotation_requests').values(values).returning('id').executeTakeFirstOrThrow()
          ).id;
        }
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: wallet.id,
          sessionId: actor.session.claims.sessionId,
          eventType: 'ROTATION_PROPOSAL_PREPARED',
          targetType: 'rotation',
          targetId: rotationId,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: {
            role: input.role,
            proposer,
            oldKey: oldValue,
            newKey: material.newKey,
            operationId: created.operationId,
          },
        });
      },
    });
    const row = await this.#d.db
      .selectFrom('rotation_requests')
      .selectAll()
      .where('propose_operation_id', '=', prepared.operationId)
      .executeTakeFirstOrThrow();
    return { rotation: this.#view(row, wallet.safe), operation: prepared };
  }

  /** Clave nueva del rol con su material verificado (nunca la manda el cliente en la propuesta). */
  async #newKeyMaterial(
    wallet: { id: string; safe: Address },
    role: RotationRole,
    chain: ProposalChainContext,
  ): Promise<{
    newKey: Address;
    keyAcceptance: { nonce: string; signature: string } | null;
    attestation: string | null;
    opaqueRecordId: string | null;
    enrollmentId: string | null;
    draftId: string | null;
  }> {
    const none = { keyAcceptance: null, attestation: null, opaqueRecordId: null, enrollmentId: null, draftId: null };
    if (role === 'U') {
      const draft = await this.#d.db
        .selectFrom('rotation_requests')
        .selectAll()
        .where('wallet_id', '=', wallet.id)
        .where('role', '=', 'U')
        .where('status', '=', 'DRAFT')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!draft?.key_acceptance || draft.opaque_record_id === null) {
        throw new ApiError('CONFLICT', { detail: 'registrá primero la clave U nueva (reemplazo de U)' });
      }
      const newKey = bufferToAddress(draft.new_key);
      await this.#assertAcceptance(wallet.id, 'U', newKey, draft.key_acceptance);
      return {
        ...none,
        newKey,
        keyAcceptance: draft.key_acceptance,
        opaqueRecordId: draft.opaque_record_id,
        draftId: draft.id,
      };
    }
    if (role === 'R') {
      const enrollment = await this.#d.db
        .selectFrom('recovery_metadata')
        .selectAll()
        .where('wallet_id', '=', wallet.id)
        .where('purpose', '=', 'REPLACEMENT')
        .where('status', '=', 'SUBMITTED')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!enrollment?.r_address || !enrollment.key_acceptance) {
        throw new ApiError('CONFLICT', { detail: 'vinculá primero la clave R nueva desde la app Recovery' });
      }
      const newKey = bufferToAddress(enrollment.r_address);
      await this.#assertAcceptance(wallet.id, 'R', newKey, enrollment.key_acceptance);
      return { ...none, newKey, keyAcceptance: enrollment.key_acceptance, enrollmentId: enrollment.id };
    }
    if (role === 'S') {
      // Una S' creada para un intento anterior que nunca se ejecutó se reutiliza (no se acumulan claves).
      const pending = await this.#d.db
        .selectFrom('signer_keys')
        .select(['address', 'attestation'])
        .where('wallet_id', '=', wallet.id)
        .where('status', '=', 'PENDING')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (pending?.attestation) {
        return { ...none, newKey: bufferToAddress(pending.address), attestation: pending.attestation };
      }
      const created = await this.#d.signerKeys.createRotationKey(wallet.id);
      if (!created.attestation) throw new Error('el signer creó la S nueva sin atestación');
      return { ...none, newKey: getAddress(created.address), attestation: created.attestation };
    }
    if (chain.successor === null || /^0x0{40}$/i.test(chain.successor)) {
      throw new ApiError('CONFLICT', { detail: 'no hay un sucesor del Guard registrado en el PolicyRegistry' });
    }
    return { ...none, newKey: getAddress(chain.successor) };
  }

  /** Hechos de la clave nueva para la ejecución, desde el material guardado del pedido (nunca del cliente). */
  async #executionFacts(rotation: RotationRow, walletId: string, newKey: Address): Promise<Partial<PolicyFacts>> {
    if (rotation.role === 'S') return { newKeyIsSignerKey: await isSignerKeyOf(this.#d.db, walletId, newKey) };
    if (rotation.role !== 'U' && rotation.role !== 'R') return {};
    const ka = rotation.key_acceptance;
    if (!ka) return { keyAcceptanceValid: false };
    return {
      keyAcceptanceValid: await keyAcceptanceValid(this.#d.snapshot(), {
        walletId,
        role: rotation.role,
        newKey,
        nonce: ka.nonce as Hex,
        signature: ka.signature as Hex,
      }),
    };
  }

  async #assertAcceptance(
    walletId: string,
    role: 'U' | 'R',
    newKey: Address,
    ka: { nonce: string; signature: string },
  ): Promise<void> {
    const ok = await keyAcceptanceValid(this.#d.snapshot(), {
      walletId,
      role,
      newKey,
      nonce: ka.nonce as Hex,
      signature: ka.signature as Hex,
    });
    if (!ok) throw new ApiError('SIGNATURE_INVALID', { detail: 'KeyAcceptance inválida para la clave nueva' });
  }

  /**
   * POST /rotations/{id}/execute/prepare: con la propuesta madura en el timelock, `swapOwner(prev, old, new)` (prev
   * leído on-chain) o, para el Guard, `setGuard`/`setModuleGuard` (GUARD_UPGRADE, sólo U).
   */
  async executePrepare(
    actor: OperationActor,
    rotationId: string,
  ): Promise<{ rotation: RotationView; operation: PreparedOperation }> {
    const rotation = await this.#rotationFor(actor.userId, rotationId);
    const signer = roleForScope(actor.session.claims.scope);
    const wallet = await walletForActor(this.#d.db, actor, rotation.wallet_id);
    if (rotation.status !== 'PENDING_TIMELOCK' && rotation.status !== 'READY_TO_EXECUTE') {
      throw new ApiError('CONFLICT', { detail: `la rotación está en ${rotation.status}` });
    }
    const role = rotation.role;
    const guardUpgrade = role === 'GUARD' || role === 'MODULE_GUARD';
    if (guardUpgrade && signer !== 'U')
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'el upgrade del Guard lo firma U' });
    if (role === 'R' && signer === 'R')
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'R no ejecuta su propia rotación' });
    const oldKey = bufferToAddress(rotation.old_key);
    const newKey = bufferToAddress(rotation.new_key);
    const snapshot = this.#d.snapshot();
    const { value } = await this.#d.rpc.readSensitive('rotation-execute', async (client, blockNumber) => {
      const state = await readSafeState(client, blockNumber, snapshot, wallet.safe);
      const id = await client.readContract({
        address: this.#timelockOf(rotation),
        abi: rotationTimelockAbi,
        functionName: 'executableProposal',
        args: [wallet.safe, KIND_OF_ROLE[role], oldKey, newKey],
        blockNumber,
      });
      return { owners: state.owners, id };
    });
    if (/^0x0{64}$/.test(value.id)) {
      throw new ApiError('CONFLICT', {
        detail: 'la propuesta todavía no maduró o ya no está pendiente en el timelock',
      });
    }
    let call: { to: Address; data: Hex };
    if (guardUpgrade) {
      call = {
        to: wallet.safe,
        data: encodeFunctionData({
          abi: iSafeAbi,
          functionName: role === 'GUARD' ? 'setGuard' : 'setModuleGuard',
          args: [newKey],
        }),
      };
    } else {
      const index = value.owners.findIndex((o) => isAddressEqual(o, oldKey));
      if (index < 0) throw new ApiError('CONFLICT', { detail: 'la clave a rotar ya no es owner de la Safe' });
      const prev: Address =
        index === 0 ? '0x0000000000000000000000000000000000000001' : (value.owners[index - 1] as Address);
      call = {
        to: wallet.safe,
        data: encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [prev, oldKey, newKey] }),
      };
    }
    const prepared = await this.#d.operations.prepare(actor, {
      walletId: wallet.id,
      operationType: guardUpgrade ? 'GUARD_UPGRADE' : 'ROTATION_EXECUTE',
      call,
      extraFacts: await this.#executionFacts(rotation, wallet.id, newKey),
      afterInsert: async (trx, created) => {
        const updated = await trx
          .updateTable('rotation_requests')
          .set({ execute_operation_id: created.operationId, failure_reason: null })
          .where('id', '=', rotation.id)
          .where('status', 'in', ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'])
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new ApiError('CONFLICT', { detail: 'la rotación cambió de estado' });
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: wallet.id,
          sessionId: actor.session.claims.sessionId,
          eventType: 'ROTATION_EXECUTION_PREPARED',
          targetType: 'rotation',
          targetId: rotation.id,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: { role, signer, operationId: created.operationId },
        });
      },
    });
    const row = await this.#d.db
      .selectFrom('rotation_requests')
      .selectAll()
      .where('id', '=', rotation.id)
      .executeTakeFirstOrThrow();
    return { rotation: this.#view(row, wallet.safe), operation: prepared };
  }

  /**
   * POST /rotations/{id}/cancel, SIN autenticación ([C-RTL-03], P15.T02): la firma `CancelRotation` tiene que ser de
   * la U o la R vigentes on-chain y la propuesta tiene que seguir pendiente; el gas tank la retransmite (cualquier
   * otro relayer o una wallet propia también podría). El estado CANCELLED llega con el evento on-chain.
   */
  async requestCancelRelay(
    rotationId: string,
    signatureInput: string,
    meta: { requestId: string; ipPrefix: string | null },
  ): Promise<{ rotation: RotationView; relay: { status: 'REQUESTED'; signer: Address; role: 'U' | 'R' } }> {
    if (!isUuid(rotationId)) throw new ApiError('NOT_FOUND');
    const rotation = await this.#d.db
      .selectFrom('rotation_requests as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .selectAll('r')
      .select(['w.safe_address', 'w.user_id'])
      .where('r.id', '=', rotationId)
      .executeTakeFirst();
    if (!rotation || rotation.proposal_id === null || rotation.safe_address === null) throw new ApiError('NOT_FOUND');
    if (
      rotation.status !== 'PENDING_TIMELOCK' &&
      rotation.status !== 'READY_TO_EXECUTE' &&
      rotation.status !== 'EXECUTING'
    ) {
      throw new ApiError('CONFLICT', { detail: `la rotación está en ${rotation.status}` });
    }
    const safe = bufferToAddress(rotation.safe_address);
    const proposalId = bufferToHex(rotation.proposal_id);
    const snapshot = this.#d.snapshot();
    const timelock = this.#timelockOf(rotation);
    // El dueño del timelock es quien valida U/R en cancelWithSignature (el Guard de la propuesta).
    const owner = guardOfTimelock(snapshot, timelock);
    if (owner === null) throw new ApiError('CONFLICT', { detail: 'el timelock de la propuesta ya no está aceptado' });
    const signature = signatureInput.toLowerCase() as Hex;
    let signer: Address;
    try {
      signer = await recoverStrictSigner(cancelRotationDigest(snapshot.chainId, timelock, proposalId, safe), signature);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        throw new ApiError('SIGNATURE_INVALID', { detail: `firma ECDSA no estricta (${error.reason})` });
      }
      throw error;
    }
    const { value } = await this.#d.rpc.readSensitive('rotation-cancel', async (client, blockNumber) => {
      const [roles, proposal] = await Promise.all([
        client.readContract({
          address: owner.guard,
          abi: securityGuardAbi,
          functionName: 'rolesOf',
          args: [safe],
          blockNumber,
        }),
        client.readContract({
          address: timelock,
          abi: rotationTimelockAbi,
          functionName: 'getProposal',
          args: [proposalId],
          blockNumber,
        }),
      ]);
      return { roles: { userKey: roles.userKey, recoveryKey: roles.recoveryKey }, status: proposal.status };
    });
    const role = isAddressEqual(signer, value.roles.userKey)
      ? 'U'
      : isAddressEqual(signer, value.roles.recoveryKey)
        ? 'R'
        : null;
    if (role === null)
      throw new ApiError('SIGNATURE_INVALID', { detail: 'la firma no es de la U ni de la R vigentes' });
    // Status del timelock: 0 = None, 1 = Pending, 2 = Cancelled, 3 = Executed.
    if (value.status !== 1) throw new ApiError('CONFLICT', { detail: 'la propuesta ya no está pendiente on-chain' });
    await withTransaction(
      this.#d.db,
      async (trx) => {
        await this.#d.outbox.enqueue(trx, {
          aggregateType: 'rotation',
          aggregateId: rotation.id,
          eventType: 'ROTATION_CANCEL_RELAY_REQUESTED',
          payload: { rotationId: rotation.id, proposalId, signature, signer, timelock },
        });
        await this.#d.audit.append(trx, {
          actorType: 'SYSTEM',
          actorId: 'rotation-cancel-relay',
          userId: rotation.user_id,
          walletId: rotation.wallet_id,
          eventType: 'ROTATION_CANCEL_REQUESTED',
          targetType: 'rotation',
          targetId: rotation.id,
          requestId: meta.requestId,
          ipPrefix: meta.ipPrefix,
          payload: { proposalId, signer, role },
        });
      },
      { auditLock: true },
    );
    return { rotation: this.#view(rotation, safe), relay: { status: 'REQUESTED', signer, role } };
  }
}
