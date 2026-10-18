// Onboarding server-side de la wallet (P12, V9 §6 y §16) — lado Wallet:
//
// CREATING: POST /wallets → U (dirección, KDF público, backups, registro OPAQUE PENDING) → enrollment de R (ver
// recovery/enrollment.ts) → asignación de S por el shard (con su SignerKeyAttestation) y Safe esperada (cálculo local
// == WalletFactory.predictWalletAddress) → U firma WalletCreationAuthorization → POST /wallets/{id}/deploy:
// DEPLOYING (+ evento de outbox; el deploy lo hace el proceso gas-tank, wallets/deployer.ts) → VERIFYING → ACTIVE.
//
// Las llamadas de red (signer, RPC) van fuera de las transacciones (que pueden reintentarse): cada transacción vuelve a
// validar el estado antes de escribir. Ninguna tabla guarda claves privadas ni passwords.
import { getAddress, isAddressEqual, keccak256, type Address, type Hex } from 'viem';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { RequestMeta } from '../auth/account-service.ts';
import { walletFactoryAbi } from '../chain/abis/index.ts';
import { predictSafeAddress, safeInitializer } from '../chain/create2.ts';
import { platformTypedData } from '../chain/eip712.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { safeProxyInitCodeHash } from '../chain/safe-proxy.ts';
import type { OutboxRepository } from '../db/repositories/outbox-repository.ts';
import type { Database, WalletStatus, WalletsTable } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OpaqueService } from '../platform-session/opaque.ts';
import { OpaqueProtocolError } from '../platform-session/opaque.ts';
import type { PlatformSessionClaims } from '../platform-session/token.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { SignerClientError } from '../signer-client/client.ts';
import type { SignerKeyService } from '../signer-client/sharding.ts';
import { walletSaltNonce } from './salt.ts';
import type { KdfParams, StorageFlags } from './schemas.ts';

export const WALLET_STATUSES = [
  'CREATING',
  'DEPLOYING',
  'VERIFYING',
  'ACTIVE',
  'SOVEREIGN_MODIFIED',
  'MIGRATING',
  'FAILED',
  'MIGRATED',
  'ABANDONED',
] as const satisfies readonly WalletStatus[];

/** Estados en los que la wallet es la "viva" del usuario (V1: una por usuario). */
export const LIVE_EXCLUDED: readonly WalletStatus[] = ['FAILED', 'ABANDONED', 'MIGRATED', 'MIGRATING'];
/** La Safe se muestra como operativa sólo desde ACTIVE (V9 §16). */
const OPERATIONAL: readonly WalletStatus[] = ['ACTIVE', 'SOVEREIGN_MODIFIED'];
export const ONBOARDING_KEY_VERSION = 1;

export type WalletRow = Selectable<WalletsTable>;

export interface WalletActor {
  userId: string;
  platform: PlatformSessionClaims;
  meta: RequestMeta;
}

export interface WalletView {
  id: string;
  status: WalletStatus;
  chainId: number;
  /** Sólo con la wallet operativa (ACTIVE): antes, la dirección esperada está en `GET /wallets/{id}/deployment`. */
  safe: Address | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface DeploymentInfo {
  walletId: string;
  status: WalletStatus;
  U: Address | null;
  R: Address | null;
  S: Address | null;
  saltNonce: string;
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
  configHash: Hex | null;
  deployTxHash: Hex | null;
  failureReason: string | null;
}

export interface CreationPlan {
  walletId: string;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  shardId: string;
  executorAttestation: string;
  saltNonce: string;
  expectedSafe: Address;
  configHash: Hex;
  enrollmentId: string;
  enrollmentNonce: Hex;
  /** Typed data EIP-712 de WalletCreationAuthorization [W-01] que firma U (saltNonce como string decimal). */
  typedData: Record<string, unknown>;
}

export interface WalletServiceDeps {
  db: Kysely<Database>;
  platformId: string;
  chainId: number;
  snapshot: () => BackendPolicySnapshot;
  signerKeys: SignerKeyService;
  opaque: OpaqueService;
  rpc: RpcQuorumClient;
  outbox: OutboxRepository;
  audit: AuditWriter;
  metrics: Metrics;
  logger: Logger;
}

export function walletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    status: row.status,
    chainId: row.chain_id,
    safe: OPERATIONAL.includes(row.status) && row.safe_address ? bufferToAddress(row.safe_address) : null,
    createdAt: row.created_at.toISOString(),
    activatedAt: row.activated_at?.toISOString() ?? null,
  };
}

/** Claves vivas (PENDING o ACTIVE) de una wallet. */
export async function liveKeys(
  db: Kysely<Database> | Transaction<Database>,
  walletId: string,
): Promise<{ U: Address | null; R: Address | null; S: Address | null }> {
  const rows = await db
    .selectFrom('wallet_keys_metadata')
    .select(['role', 'key_address'])
    .where('wallet_id', '=', walletId)
    .where('status', 'in', ['PENDING', 'ACTIVE'])
    .execute();
  const of = (role: 'U' | 'R' | 'S') => {
    const row = rows.find((r) => r.role === role);
    return row ? bufferToAddress(row.key_address) : null;
  };
  return { U: of('U'), R: of('R'), S: of('S') };
}

/** Credencial sana que reutiliza la wallet nueva de una migración excepcional, en el mismo rol (P15.T06). */
export interface MigrationReuse {
  fromWalletId: string;
  role: 'U' | 'R';
  key: Address;
}

export async function migrationReuse(
  db: Kysely<Database> | Transaction<Database>,
  walletId: string,
): Promise<MigrationReuse | null> {
  const row = await db
    .selectFrom('migration_cases as c')
    .innerJoin('wallet_keys_metadata as k', (join) =>
      join
        .onRef('k.wallet_id', '=', 'c.old_wallet_id')
        .onRef('k.role', '=', 'c.healthy_role')
        .on('k.status', '=', 'ACTIVE'),
    )
    .select(['c.old_wallet_id', 'c.healthy_role', 'k.key_address'])
    .where('c.new_wallet_id', '=', walletId)
    .where('c.status', '=', 'APPROVED')
    .executeTakeFirst();
  return row
    ? { fromWalletId: row.old_wallet_id, role: row.healthy_role, key: bufferToAddress(row.key_address) }
    : null;
}

/** En la wallet nueva de una migración, el rol sano tiene que ser exactamente la credencial sana de la vieja. */
export function assertMigrationKey(reuse: MigrationReuse | null, role: 'U' | 'R', key: Address): void {
  if (reuse?.role === role && !isAddressEqual(reuse.key, key)) {
    throw new ApiError('KEY_NOT_ALLOWED', {
      detail: `en la migración, ${role} tiene que ser la credencial sana de la wallet anterior`,
    });
  }
}

/** Versión de una clave U o R nueva de una wallet activa (la siguiente a la última vigente o rotada). */
export async function nextKeyVersion(
  db: Kysely<Database> | Transaction<Database>,
  walletId: string,
  role: 'U' | 'R',
): Promise<number> {
  const row = await db
    .selectFrom('wallet_keys_metadata')
    .select((eb) => eb.fn.max('key_version').as('v'))
    .where('wallet_id', '=', walletId)
    .where('role', '=', role)
    .where('status', 'in', ['ACTIVE', 'ROTATED_OUT'])
    .executeTakeFirst();
  return (row?.v ?? 0) + 1;
}

/** Enrollment vivo (SUBMITTED o CONFIRMED) de la wallet. */
export async function liveEnrollment(db: Kysely<Database> | Transaction<Database>, walletId: string) {
  return db
    .selectFrom('recovery_metadata')
    .selectAll()
    .where('wallet_id', '=', walletId)
    .where('status', 'in', ['SUBMITTED', 'CONFIRMED'])
    .executeTakeFirst();
}

/** Estados del onboarding: una sesión ONBOARDING emitida antes de crear la wallet sólo vale mientras dure. */
const ONBOARDING_STATUSES: readonly WalletStatus[] = ['CREATING', 'DEPLOYING', 'VERIFYING'];

/**
 * Wallet del recurso para la PlatformSession del request [B-AUTHZ]: de otro usuario → 404; una sesión atada a otra
 * wallet → 403; una sesión ONBOARDING emitida antes de crear la wallet (walletId null) sólo vale para la wallet de
 * onboarding del mismo usuario (V1: una viva por usuario) mientras esté en CREATING, DEPLOYING o VERIFYING.
 */
export async function walletForActor(
  db: Kysely<Database> | Transaction<Database>,
  platformId: string,
  actor: WalletActor,
  walletId: string,
  options: { forUpdate?: boolean } = {},
): Promise<WalletRow> {
  let query = db
    .selectFrom('wallets')
    .selectAll()
    .where('id', '=', walletId)
    .where('user_id', '=', actor.userId)
    .where('platform_id', '=', platformId);
  if (options.forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  const bound = actor.platform.walletId;
  if (bound === null) {
    if (actor.platform.scope !== 'ONBOARDING' || !ONBOARDING_STATUSES.includes(row.status)) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession no está atada a esta wallet' });
    }
  } else if (bound !== row.id) {
    throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
  }
  return row;
}

/**
 * La clave no puede estar (ni haber estado) en otra wallet ni en otro rol, ni ser una S del signer, ni la R viva de
 * otro enrollment (para U: de ningún enrollment, R ≠ U).
 */
export async function assertKeyUnused(
  trx: Transaction<Database>,
  key: Address,
  own: { walletId: string; role: 'U' | 'R' },
  reuse: MigrationReuse | null = null,
): Promise<void> {
  const bytes = addressToBuffer(key);
  // La credencial sana de una migración excepcional (P15.T06) puede seguir viva en la wallet vieja, en el mismo rol.
  const reused = (walletId: string, role: string) =>
    reuse !== null &&
    reuse.role === own.role &&
    role === own.role &&
    walletId === reuse.fromWalletId &&
    isAddressEqual(reuse.key, key);
  const metadata = await trx
    .selectFrom('wallet_keys_metadata')
    .select(['wallet_id', 'role', 'status'])
    .where('key_address', '=', bytes)
    .execute();
  const foreign = metadata.some(
    (m) =>
      !reused(m.wallet_id, m.role) &&
      (m.wallet_id !== own.walletId || m.role !== own.role || (m.status !== 'PENDING' && m.status !== 'REVOKED')),
  );
  const signer = await trx.selectFrom('signer_keys').select('id').where('address', '=', bytes).executeTakeFirst();
  const enrolled = await trx
    .selectFrom('recovery_metadata')
    .select('wallet_id')
    .where('r_address', '=', bytes)
    .where('status', 'in', ['SUBMITTED', 'CONFIRMED'])
    .execute();
  const enrolledElsewhere = enrolled.some(
    (e) => !reused(e.wallet_id, 'R') && (own.role === 'U' || e.wallet_id !== own.walletId),
  );
  if (foreign || signer !== undefined || enrolledElsewhere) {
    throw new ApiError('KEY_NOT_ALLOWED', { detail: 'la clave ya se usa en otra wallet o en otro rol' });
  }
}

export class WalletService {
  readonly #d: WalletServiceDeps;

  constructor(deps: WalletServiceDeps) {
    this.#d = deps;
  }

  #requireCreating(wallet: WalletRow): void {
    if (wallet.status !== 'CREATING') {
      throw new ApiError('CONFLICT', { detail: `la wallet está en ${wallet.status}: el onboarding ya avanzó` });
    }
  }

  /** POST /wallets: inicia el onboarding (o devuelve la wallet en CREATING para retomarlo). */
  async create(actor: WalletActor): Promise<{ wallet: WalletView; created: boolean }> {
    const { db, platformId, chainId } = this.#d;
    const result = await withTransaction(
      db,
      async (trx) => {
        const live = await trx
          .selectFrom('wallets')
          .selectAll()
          .where('user_id', '=', actor.userId)
          .where('platform_id', '=', platformId)
          .where('status', 'not in', LIVE_EXCLUDED)
          .forUpdate()
          .executeTakeFirst();
        if (live) {
          if (live.status !== 'CREATING') {
            throw new ApiError('CONFLICT', { detail: `ya tenés una wallet en ${live.status}` });
          }
          await walletForActor(trx, platformId, actor, live.id);
          return { wallet: walletView(live), created: false };
        }
        if (actor.platform.walletId !== null) {
          throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
        }
        // Migración excepcional aprobada (P15.T06): la wallet nueva queda vinculada a la vieja (MIGRATING) y al caso.
        const migration = await trx
          .selectFrom('migration_cases as c')
          .innerJoin('wallets as w', 'w.id', 'c.old_wallet_id')
          .select(['c.id', 'c.old_wallet_id'])
          .where('c.user_id', '=', actor.userId)
          .where('c.status', '=', 'APPROVED')
          .where('w.status', '=', 'MIGRATING')
          .where('w.platform_id', '=', platformId)
          .forUpdate()
          .executeTakeFirst();
        const row = await trx
          .insertInto('wallets')
          .values({
            user_id: actor.userId,
            platform_id: platformId,
            chain_id: chainId,
            status: 'CREATING',
            migrated_from_wallet_id: migration?.old_wallet_id ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (migration) {
          await trx
            .updateTable('migration_cases')
            .set({ new_wallet_id: row.id })
            .where('id', '=', migration.id)
            .execute();
        }
        await this.#audit(trx, actor, row.id, 'WALLET_CREATED', {
          chainId,
          ...(migration ? { migratedFromWalletId: migration.old_wallet_id, migrationCaseId: migration.id } : {}),
        });
        return { wallet: walletView(row), created: true };
      },
      { auditLock: true },
    );
    if (result.created) this.#d.metrics.walletOnboarding.inc({ step: 'create', result: 'ok' });
    return result;
  }

  /** GET /wallets/me: la wallet viva del usuario (o null). */
  async me(userId: string): Promise<WalletView | null> {
    const row = await this.#d.db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .where('platform_id', '=', this.#d.platformId)
      .where('status', 'not in', LIVE_EXCLUDED)
      .executeTakeFirst();
    return row ? walletView(row) : null;
  }

  /**
   * Registro OPAQUE, paso 1 (sin estado en el servidor): respuesta al pedido del cliente para la clave U de la wallet.
   * ONBOARDING: U todavía no autorizó la creación; KEY_RESTORE: la wallet ACTIVE y su U vigente.
   */
  async opaqueRegistration(
    actor: WalletActor,
    walletId: string,
    registrationRequest: string,
  ): Promise<{ registrationResponse: string; keyVersion: number }> {
    const wallet = await walletForActor(this.#d.db, this.#d.platformId, actor, walletId);
    const keyVersion = await this.#opaqueKeyVersion(this.#d.db, actor, wallet);
    try {
      return {
        registrationResponse: this.#d.opaque.registrationResponse({ walletId, keyVersion, registrationRequest }),
        keyVersion,
      };
    } catch (error) {
      if (error instanceof OpaqueProtocolError) throw new ApiError('VALIDATION_FAILED', { detail: error.message });
      throw error;
    }
  }

  async #opaqueKeyVersion(
    db: Kysely<Database> | Transaction<Database>,
    actor: WalletActor,
    wallet: WalletRow,
  ): Promise<number> {
    if (actor.platform.scope === 'U_REPLACEMENT') {
      // U' de una wallet activa (P15.T04): la versión siguiente a la última U.
      if (wallet.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE');
      return nextKeyVersion(db, wallet.id, 'U');
    }
    if (actor.platform.scope === 'KEY_RESTORE') {
      if (wallet.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE');
      const u = await db
        .selectFrom('wallet_keys_metadata')
        .select('key_version')
        .where('wallet_id', '=', wallet.id)
        .where('role', '=', 'U')
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (!u) throw new ApiError('WALLET_NOT_ACTIVE', { detail: 'la wallet no tiene una U vigente' });
      return u.key_version;
    }
    this.#requireCreating(wallet);
    const confirmed = await liveEnrollment(db, wallet.id);
    if (confirmed?.status === 'CONFIRMED') {
      throw new ApiError('CONFLICT', { detail: 'U ya autorizó la creación de la Safe: no se puede cambiar' });
    }
    return ONBOARDING_KEY_VERSION;
  }

  /**
   * POST /wallets/{id}/user-key: dirección de U, KDF público, backups confirmados y registro OPAQUE PENDING (pasa a
   * ACTIVE cuando la wallet queda ACTIVE). Mientras U no autorizó la creación se puede reemplazar.
   */
  async registerUserKey(
    actor: WalletActor,
    walletId: string,
    input: { userKey: Address; kdfParams: KdfParams; storageFlags: StorageFlags; registrationRecord: string },
  ): Promise<{ userKey: Address; keyVersion: number; status: 'PENDING' }> {
    const { db, platformId } = this.#d;
    const userKey = getAddress(input.userKey);
    await withTransaction(
      db,
      async (trx) => {
        const wallet = await walletForActor(trx, platformId, actor, walletId, { forUpdate: true });
        if (actor.platform.scope !== 'ONBOARDING') throw new ApiError('SCOPE_NOT_ALLOWED');
        const keyVersion = await this.#opaqueKeyVersion(trx, actor, wallet);
        const reuse = await migrationReuse(trx, walletId);
        assertMigrationKey(reuse, 'U', userKey);
        await assertKeyUnused(trx, userKey, { walletId, role: 'U' }, reuse);
        const current = await trx
          .selectFrom('wallet_keys_metadata')
          .select(['id', 'key_address'])
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'U')
          .where('status', '=', 'PENDING')
          .executeTakeFirst();
        const metadata = {
          kdf_params: JSON.stringify(input.kdfParams),
          storage_flags: JSON.stringify(input.storageFlags),
        };
        if (current && isAddressEqual(bufferToAddress(current.key_address), userKey)) {
          await trx.updateTable('wallet_keys_metadata').set(metadata).where('id', '=', current.id).execute();
        } else {
          if (current) {
            await trx
              .updateTable('wallet_keys_metadata')
              .set({ status: 'REVOKED', deactivated_at: sql`now()` })
              .where('id', '=', current.id)
              .execute();
          }
          await trx
            .insertInto('wallet_keys_metadata')
            .values({
              wallet_id: walletId,
              role: 'U',
              key_address: addressToBuffer(userKey),
              key_version: keyVersion,
              status: 'PENDING',
              source: 'INTERNAL',
              reused_from_wallet_id: reuse?.role === 'U' ? reuse.fromWalletId : null,
              ...metadata,
            })
            .execute();
          // La Safe esperada dependía de la U anterior: se recalcula al volver a asignar S.
          await trx
            .updateTable('wallets')
            .set({ expected_safe: null, config_hash: null, updated_at: sql`now()` })
            .where('id', '=', walletId)
            .execute();
        }
        try {
          await this.#d.opaque.storeRegistration(trx, {
            userId: actor.userId,
            walletId,
            keyVersion,
            registrationRecord: input.registrationRecord,
          });
        } catch (error) {
          if (error instanceof OpaqueProtocolError) throw new ApiError('VALIDATION_FAILED', { detail: error.message });
          throw error;
        }
        await this.#audit(trx, actor, walletId, 'WALLET_USER_KEY_REGISTERED', {
          userKey,
          keyVersion,
          storageFlags: input.storageFlags,
          kdfMemoryKiB: input.kdfParams.memoryKiB,
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'user_key', result: 'ok' });
    return { userKey, keyVersion: ONBOARDING_KEY_VERSION, status: 'PENDING' };
  }

  /**
   * POST /wallets/{id}/executor: con R ya enviada por Recovery, el shard asignado crea S (con su atestación, P12.T03) y
   * se fija la Safe esperada (P12.T04): cálculo local (initializer + CREATE2 con el creation code fijado) ==
   * WalletFactory.predictWalletAddress por quórum. Idempotente.
   */
  async assignExecutor(actor: WalletActor, walletId: string): Promise<CreationPlan> {
    const { db, platformId, chainId } = this.#d;
    const snapshot = this.#d.snapshot();
    const wallet = await walletForActor(db, platformId, actor, walletId);
    this.#requireCreating(wallet);
    const keys = await liveKeys(db, walletId);
    const enrollment = await liveEnrollment(db, walletId);
    if (keys.U === null) throw new ApiError('CONFLICT', { detail: 'falta registrar la clave U' });
    if (!enrollment?.r_address || keys.R === null) {
      throw new ApiError('CONFLICT', { detail: 'falta que Recovery envíe la clave R' });
    }
    const recoveryKey = bufferToAddress(enrollment.r_address);

    let executor;
    try {
      executor = await this.#d.signerKeys.ensureExecutor(walletId);
    } catch (error) {
      this.#d.metrics.walletOnboarding.inc({ step: 'executor', result: 'signer_error' });
      if (error instanceof SignerClientError) {
        this.#d.logger.warn({ walletId, code: error.code, retryable: error.retryable }, 'el signer no asignó S');
        throw new ApiError('SERVICE_UNAVAILABLE', { detail: 'el signer no pudo crear la clave S; reintentá' });
      }
      throw error;
    }
    if (executor.attestation === null) throw new Error(`la S de ${walletId} no tiene SignerKeyAttestation`);

    const saltNonce = walletSaltNonce(platformId, walletId);
    const walletKeys = { userKey: keys.U, recoveryKey, executor: executor.address };
    const initializer = safeInitializer(walletKeys, snapshot.contracts.safeBootstrap);
    const configHash = keccak256(initializer);
    const local = predictSafeAddress({
      safeProxyFactory: snapshot.contracts.safeProxyFactory,
      initCodeHash: safeProxyInitCodeHash(snapshot.contracts.safeL2Singleton),
      initializer,
      saltNonce,
    });
    const { value: onChain } = await this.#d.rpc.readContract({
      address: snapshot.contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'predictWalletAddress',
      args: [walletKeys.userKey, walletKeys.recoveryKey, walletKeys.executor, saltNonce],
    });
    if (!isAddressEqual(local, onChain)) {
      // El snapshot, la configuración fijada o la factory no son los esperados: nunca se continúa.
      this.#d.metrics.walletOnboarding.inc({ step: 'executor', result: 'address_mismatch' });
      this.#d.logger.error(
        { walletId, local, onChain },
        'la Safe esperada local no coincide con la de la WalletFactory',
      );
      throw new ApiError('SERVICE_UNAVAILABLE', { detail: 'no se pudo calcular la dirección de la Safe' });
    }

    await withTransaction(
      db,
      async (trx) => {
        const current = await walletForActor(trx, platformId, actor, walletId, { forUpdate: true });
        this.#requireCreating(current);
        const nowKeys = await liveKeys(trx, walletId);
        const nowEnrollment = await liveEnrollment(trx, walletId);
        if (
          nowKeys.U === null ||
          !isAddressEqual(nowKeys.U, walletKeys.userKey) ||
          nowEnrollment?.id !== enrollment.id
        ) {
          throw new ApiError('CONFLICT', { detail: 'las claves cambiaron mientras se asignaba S: reintentá' });
        }
        if (nowEnrollment.status === 'CONFIRMED') {
          // U ya firmó la autorización: sólo se acepta exactamente la misma Safe.
          if (!current.expected_safe || !isAddressEqual(bufferToAddress(current.expected_safe), local)) {
            throw new ApiError('CONFLICT', { detail: 'la creación ya está autorizada con otra Safe' });
          }
          return;
        }
        await trx
          .updateTable('wallets')
          .set({
            salt_nonce: saltNonce.toString(),
            factory_address: addressToBuffer(snapshot.contracts.walletFactory),
            singleton_address: addressToBuffer(snapshot.contracts.safeL2Singleton),
            config_hash: Buffer.from(configHash.slice(2), 'hex'),
            expected_safe: addressToBuffer(local),
            updated_at: sql`now()`,
          })
          .where('id', '=', walletId)
          .execute();
        if (nowKeys.S === null) {
          await trx
            .insertInto('wallet_keys_metadata')
            .values({
              wallet_id: walletId,
              role: 'S',
              key_address: addressToBuffer(executor.address),
              key_version: 1,
              status: 'PENDING',
              source: 'SIGNER_SHARD',
            })
            .execute();
        } else if (!isAddressEqual(nowKeys.S, executor.address)) {
          throw new Error(`la S guardada de ${walletId} no coincide con la del signer`);
        }
        await this.#audit(trx, actor, walletId, 'WALLET_EXECUTOR_ASSIGNED', {
          executor: executor.address,
          shardId: executor.shardId,
          expectedSafe: local,
          saltNonce: saltNonce.toString(),
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'executor', result: 'ok' });
    if (enrollment.nonce === null) throw new Error(`el enrollment ${enrollment.enrollment_id} no tiene nonce`);
    const enrollmentNonce = bufferToHex(enrollment.nonce);
    const message = {
      userId: actor.userId,
      platformId,
      walletId,
      userKey: walletKeys.userKey,
      recoveryKey,
      executor: executor.address,
      saltNonce,
      expectedSafe: local,
      enrollmentNonce,
    };
    const typed = platformTypedData(chainId, snapshot.contracts.walletFactory, 'WalletCreationAuthorization', message);
    return {
      walletId,
      userKey: walletKeys.userKey,
      recoveryKey,
      executor: executor.address,
      shardId: executor.shardId,
      executorAttestation: executor.attestation,
      saltNonce: saltNonce.toString(),
      expectedSafe: local,
      configHash,
      enrollmentId: enrollment.enrollment_id,
      enrollmentNonce,
      typedData: { ...typed, message: { ...message, saltNonce: saltNonce.toString() } },
    };
  }

  /**
   * POST /wallets/{id}/deploy: con la creación autorizada por U, la wallet pasa a DEPLOYING y el evento de outbox
   * lleva el deploy al proceso gas-tank (fondeo de S y createWallet). Idempotente: si ya pasó, devuelve el estado.
   */
  async requestDeploy(actor: WalletActor, walletId: string): Promise<{ wallet: WalletView; requested: boolean }> {
    const { db, platformId } = this.#d;
    const result = await withTransaction(
      db,
      async (trx) => {
        const wallet = await walletForActor(trx, platformId, actor, walletId, { forUpdate: true });
        if (wallet.status === 'DEPLOYING' || wallet.status === 'VERIFYING' || wallet.status === 'ACTIVE') {
          return { wallet: walletView(wallet), requested: false };
        }
        this.#requireCreating(wallet);
        const enrollment = await liveEnrollment(trx, walletId);
        const keys = await liveKeys(trx, walletId);
        const signer = await trx
          .selectFrom('signer_keys')
          .select('address')
          .where('wallet_id', '=', walletId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (
          enrollment?.status !== 'CONFIRMED' ||
          keys.U === null ||
          keys.R === null ||
          keys.S === null ||
          !signer ||
          !wallet.expected_safe ||
          wallet.salt_nonce === null
        ) {
          throw new ApiError('CONFLICT', { detail: 'falta la autorización de creación firmada por U' });
        }
        const updated = await trx
          .updateTable('wallets')
          .set({ status: 'DEPLOYING', deploy_requested_at: sql`now()`, updated_at: sql`now()` })
          .where('id', '=', walletId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#d.outbox.enqueue(trx, {
          aggregateType: 'wallet',
          aggregateId: walletId,
          eventType: 'WALLET_DEPLOY_REQUESTED',
          payload: { walletId },
        });
        await this.#audit(trx, actor, walletId, 'WALLET_DEPLOY_REQUESTED', {
          expectedSafe: bufferToAddress(wallet.expected_safe),
        });
        return { wallet: walletView(updated), requested: true };
      },
      { auditLock: true },
    );
    if (result.requested) this.#d.metrics.walletOnboarding.inc({ step: 'deploy', result: 'requested' });
    return result;
  }

  /** GET /wallets/{id}/deployment: estado y todo lo que el frontend necesita para verificar por su cuenta. */
  async deployment(actor: { userId: string }, walletId: string): Promise<DeploymentInfo> {
    const { db, platformId } = this.#d;
    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('id', '=', walletId)
      .where('user_id', '=', actor.userId)
      .where('platform_id', '=', platformId)
      .executeTakeFirst();
    if (!wallet) throw new ApiError('NOT_FOUND');
    const snapshot = this.#d.snapshot();
    const keys = await liveKeys(db, walletId);
    const enrollment = await liveEnrollment(db, walletId);
    const c = snapshot.contracts;
    return {
      walletId,
      status: wallet.status,
      U: keys.U,
      R: keys.R ?? (enrollment?.r_address ? bufferToAddress(enrollment.r_address) : null),
      S: keys.S,
      saltNonce: walletSaltNonce(platformId, walletId).toString(),
      factory: c.walletFactory,
      singleton: c.safeL2Singleton,
      proxyFactory: c.safeProxyFactory,
      bootstrap: c.safeBootstrap,
      guard: c.securityGuard,
      moduleGuard: c.denyAllModuleGuard,
      timelock: c.rotationTimelock,
      policyRegistry: c.policyRegistry,
      whitelist: c.destinationWhitelist,
      swapExecutor: c.swapExecutor,
      expectedSafe: wallet.expected_safe ? bufferToAddress(wallet.expected_safe) : null,
      configHash: wallet.config_hash ? bufferToHex(wallet.config_hash) : null,
      deployTxHash: wallet.deploy_tx_hash ? bufferToHex(wallet.deploy_tx_hash) : null,
      failureReason: wallet.failure_reason,
    };
  }

  async #audit(
    trx: Transaction<Database>,
    actor: WalletActor,
    walletId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.#d.audit.append(trx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      walletId,
      sessionId: actor.platform.accountSessionId,
      eventType,
      targetType: 'wallet',
      targetId: walletId,
      requestId: actor.meta.requestId,
      ipPrefix: actor.meta.ipPrefix,
      payload: { client: actor.meta.client, platformSessionId: actor.platform.sessionId, ...payload },
    });
  }
}
