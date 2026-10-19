// Enrollment de la clave de recuperación R (P12.T02) y autorización de creación firmada por U (P12.T05):
//
// 1. Wallet (ONBOARDING) crea el enrollment: nonce de 32 bytes y 15 min de vigencia (el QR/link a Recovery lleva id y
//    nonce).
// 2. Recovery (ENROLLMENT) registra su Enrollment Key P-256 (una sola vez).
// 3. Recovery envía `RecoveryEnrollment {userId, platformId, R, nonce, issuedAt, expiresAt}` firmado por la Enrollment
//    Key sobre su JSON canónico JCS [W-02] y la prueba de control de R (EIP-712 RecoveryProofOfControl [W-01]). R debe
//    ser una EOA (sin código o con designador EIP-7702), distinta de U y nunca usada por otra wallet.
// 4. Wallet (ONBOARDING), ya con S asignada y la Safe esperada calculada, envía la WalletCreationAuthorization firmada
//    por U: el backend la acepta sólo si cada campo coincide con lo registrado (R del enrollment, S, salt, Safe).
//
// Reemplazo de R (P15.T05, "perdí R"): con la wallet ACTIVE, Wallet (OPERATIONS, U desbloqueada) crea un enrollment de
// propósito REPLACEMENT; Recovery (ENROLLMENT) registra su Enrollment Key y envía R' con la prueba de control y además
// la KeyAcceptance de R' [W-01] (nonce = el del enrollment). No hay paso 4: U propone la rotación de R hacia R'
// (rotations/service.ts) y, ejecutada on-chain, el enrollment queda CONFIRMED y el anterior RETIRED.
//
// Rechazo (P17.MAN, N10): si la Wallet no puede confirmar la R de un pedido ([F-LNK-02]: la comparación manual no
// coincide, el enlace de regreso trae otra R o no lo armó la app Recovery del usuario), lo aborta y lo informa: el
// pedido queda REJECTED con el motivo, su R pendiente deja de estar viva y, como puede ser una sustitución de R en el
// camino, queda auditado, el usuario recibe una notificación y un email de seguridad y se registra la alerta.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { platformDigest } from '../chain/eip712.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { Database, RecoveryMetadataTable, RecoveryRejectionReason } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import { canonicalJson } from '../lib/jcs.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { jwkThumbprint, verifyP256, type P256PublicJwk } from '../platform-session/keys.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { keyAcceptanceValid } from '../rotations/facts.ts';
import {
  assertKeyUnused,
  assertMigrationKey,
  liveEnrollment,
  liveKeys,
  migrationReuse,
  nextKeyVersion,
  walletForActor,
  type WalletActor,
} from '../wallets/wallet-service.ts';
import type { StorageFlags } from '../wallets/schemas.ts';
import type { Selectable } from 'kysely';

export const ENROLLMENT_TTL_SECONDS = 15 * 60;
/** Vigencia máxima del objeto RecoveryEnrollment firmado y tolerancia de reloj. */
const ENROLLMENT_OBJECT_MAX_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 60;
/** Designador de delegación EIP-7702 (0xef0100 ‖ dirección): la cuenta sigue siendo una EOA. */
const EIP7702_DESIGNATOR = /^0xef0100[0-9a-f]{40}$/;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Motivos con los que la Wallet aborta un enrollment ([F-LNK-02]): la dirección copiada de Recovery no coincidió en los
 * intentos de la comparación manual, el enlace de regreso trae otra R, o el enlace de regreso no lo armó la app
 * Recovery del usuario (no trae el secreto del pedido, o trae otro).
 */
export const WALLET_REJECTION_REASONS = [
  'MANUAL_COMPARISON_FAILED',
  'RETURN_LINK_KEY_MISMATCH',
  'RETURN_LINK_UNVERIFIED',
] as const satisfies readonly RecoveryRejectionReason[];
export type WalletRejectionReason = (typeof WALLET_REJECTION_REASONS)[number];

/** `RecoveryEnrollment` tal como lo firmó la Enrollment Key (sin transformar: la firma cubre estos strings). */
export const RecoveryEnrollmentSchema = z
  .object({
    userId: z.uuid(),
    platformId: z.string().min(2).max(63),
    R: z
      .string()
      .refine((v) => isAddress(v, { strict: true }) && v === getAddress(v), { error: 'R con checksum EIP-55' }),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/, { error: 'nonce de 32 bytes en hex minúscula' }),
    issuedAt: z.string().regex(ISO_UTC, { error: 'fecha ISO 8601 en UTC' }),
    expiresAt: z.string().regex(ISO_UTC, { error: 'fecha ISO 8601 en UTC' }),
  })
  .strict()
  .meta({ id: 'RecoveryEnrollment', description: 'Objeto firmado por la Enrollment Key ([W-02])' });

export type RecoveryEnrollment = z.infer<typeof RecoveryEnrollmentSchema>;

export interface EnrollmentView {
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
  /** Por qué quedó REJECTED (null si no lo está o si se rechazó antes de que existiera el motivo). */
  rejectionReason: RecoveryRejectionReason | null;
}

export interface WalletCreationAuthorizationInput {
  userId: string;
  platformId: string;
  walletId: string;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  saltNonce: string;
  expectedSafe: Address;
  enrollmentNonce: Hex;
}

export interface EnrollmentServiceDeps {
  db: Kysely<Database>;
  platformId: string;
  chainId: number;
  snapshot: () => BackendPolicySnapshot;
  rpc: RpcQuorumClient;
  audit: AuditWriter;
  /** Email de seguridad del rechazo (null en los tests que no lo necesitan). */
  emails: EmailOutbox | null;
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
}

type EnrollmentRow = Selectable<RecoveryMetadataTable>;

function effectiveStatus(row: EnrollmentRow, now: number): EnrollmentView['status'] {
  return row.status === 'REQUESTED' && row.expires_at.getTime() <= now ? 'EXPIRED' : row.status;
}

function view(row: EnrollmentRow, now: number): EnrollmentView {
  return {
    id: row.enrollment_id,
    walletId: row.wallet_id,
    purpose: row.purpose,
    status: effectiveStatus(row, now),
    expiresAt: row.expires_at.toISOString(),
    enrollmentKeyRegistered: row.enrollment_key_jwk !== null,
    recoveryKey: row.r_address ? bufferToAddress(row.r_address) : null,
    rType: row.r_type,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    rejectionReason: row.status === 'REJECTED' ? row.rejection_reason : null,
  };
}

export class EnrollmentService {
  readonly #d: EnrollmentServiceDeps;

  constructor(deps: EnrollmentServiceDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** Enrollment del usuario (404 si no existe o es de otro usuario). */
  async #load(
    db: Kysely<Database> | Transaction<Database>,
    userId: string,
    enrollmentId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<EnrollmentRow> {
    let query = db
      .selectFrom('recovery_metadata as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .selectAll('r')
      .where('r.enrollment_id', '=', enrollmentId)
      .where('w.user_id', '=', userId)
      .where('w.platform_id', '=', this.#d.platformId);
    if (options.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }

  /** Recovery (ENROLLMENT): la sesión tiene que estar atada a la wallet del enrollment. */
  #requireEnrollmentSession(actor: WalletActor, row: EnrollmentRow): void {
    if (actor.platform.scope !== 'ENROLLMENT' || actor.platform.walletId !== row.wallet_id) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession no es de este enrollment' });
    }
  }

  #requireOpen(row: EnrollmentRow): void {
    const status = effectiveStatus(row, this.#now());
    if (status === 'EXPIRED') throw new ApiError('ENROLLMENT_EXPIRED');
    if (status !== 'REQUESTED') throw new ApiError('CONFLICT', { detail: `el enrollment está ${status}` });
  }

  /**
   * POST /wallets/{id}/recovery/enrollments (Wallet): ONBOARDING durante el onboarding u OPERATIONS (U desbloqueada)
   * para el reemplazo de R de una wallet ACTIVE. Un enrollment nuevo reemplaza a los anteriores del mismo propósito.
   */
  async request(
    actor: WalletActor,
    walletId: string,
  ): Promise<{
    enrollmentId: string;
    nonce: Hex;
    expiresAt: string;
    status: 'REQUESTED';
    purpose: 'ONBOARDING' | 'REPLACEMENT';
  }> {
    if (actor.platform.scope === 'OPERATIONS') return this.#requestReplacement(actor, walletId);
    const { db, platformId } = this.#d;
    const result = await withTransaction(
      db,
      async (trx) => {
        const wallet = await walletForActor(trx, platformId, actor, walletId, { forUpdate: true });
        if (actor.platform.scope !== 'ONBOARDING') throw new ApiError('SCOPE_NOT_ALLOWED');
        if (wallet.status !== 'CREATING') {
          throw new ApiError('CONFLICT', { detail: `la wallet está en ${wallet.status}` });
        }
        const keys = await liveKeys(trx, walletId);
        if (keys.U === null) throw new ApiError('CONFLICT', { detail: 'falta registrar la clave U' });
        const live = await liveEnrollment(trx, walletId);
        if (live?.status === 'CONFIRMED') {
          throw new ApiError('CONFLICT', { detail: 'U ya autorizó la creación con la R vinculada' });
        }
        // Los enrollments anteriores quedan rechazados (reemplazados) y su R (si la había) deja de estar viva.
        await trx
          .updateTable('recovery_metadata')
          .set({ status: 'REJECTED', rejection_reason: 'SUPERSEDED', rejected_at: new Date(this.#now()) })
          .where('wallet_id', '=', walletId)
          .where('status', 'in', ['REQUESTED', 'SUBMITTED'])
          .execute();
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'REVOKED', deactivated_at: sql`now()` })
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'R')
          .where('status', '=', 'PENDING')
          .execute();
        await trx
          .updateTable('wallets')
          .set({ expected_safe: null, config_hash: null, updated_at: sql`now()` })
          .where('id', '=', walletId)
          .execute();
        const enrollmentId = randomUUID();
        const nonce = randomBytes(32);
        const expiresAt = new Date(this.#now() + ENROLLMENT_TTL_SECONDS * 1000);
        await trx
          .insertInto('recovery_metadata')
          .values({
            wallet_id: walletId,
            enrollment_id: enrollmentId,
            nonce,
            status: 'REQUESTED',
            expires_at: expiresAt,
          })
          .execute();
        await this.#audit(trx, actor, walletId, enrollmentId, 'RECOVERY_ENROLLMENT_REQUESTED', {
          expiresAt: expiresAt.toISOString(),
        });
        return {
          enrollmentId,
          nonce: bufferToHex(nonce),
          expiresAt: expiresAt.toISOString(),
          status: 'REQUESTED' as const,
          purpose: 'ONBOARDING' as const,
        };
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'enrollment', result: 'requested' });
    return result;
  }

  /** Enrollment de R' para el reemplazo de R (wallet ACTIVE, sin otra rotación de R en curso). */
  async #requestReplacement(
    actor: WalletActor,
    walletId: string,
  ): Promise<{ enrollmentId: string; nonce: Hex; expiresAt: string; status: 'REQUESTED'; purpose: 'REPLACEMENT' }> {
    const { db, platformId } = this.#d;
    return withTransaction(
      db,
      async (trx) => {
        const wallet = await walletForActor(trx, platformId, actor, walletId, { forUpdate: true });
        if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
        const rotating = await trx
          .selectFrom('rotation_requests')
          .select('id')
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'R')
          .where('status', 'in', [
            'AWAITING_SIGNATURE',
            'PROPOSING',
            'PENDING_TIMELOCK',
            'READY_TO_EXECUTE',
            'EXECUTING',
          ])
          .executeTakeFirst();
        if (rotating) throw new ApiError('CONFLICT', { detail: 'ya hay una rotación de R en curso' });
        // Los reemplazos anteriores sin proponer quedan rechazados (reemplazados) y su R' deja de estar viva.
        await trx
          .updateTable('recovery_metadata')
          .set({ status: 'REJECTED', rejection_reason: 'SUPERSEDED', rejected_at: new Date(this.#now()) })
          .where('wallet_id', '=', walletId)
          .where('purpose', '=', 'REPLACEMENT')
          .where('status', 'in', ['REQUESTED', 'SUBMITTED'])
          .execute();
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'REVOKED', deactivated_at: sql`now()` })
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'R')
          .where('status', '=', 'PENDING')
          .execute();
        const enrollmentId = randomUUID();
        const nonce = randomBytes(32);
        const expiresAt = new Date(this.#now() + ENROLLMENT_TTL_SECONDS * 1000);
        await trx
          .insertInto('recovery_metadata')
          .values({
            wallet_id: walletId,
            enrollment_id: enrollmentId,
            nonce,
            status: 'REQUESTED',
            purpose: 'REPLACEMENT',
            expires_at: expiresAt,
          })
          .execute();
        await this.#audit(trx, actor, walletId, enrollmentId, 'RECOVERY_ENROLLMENT_REQUESTED', {
          purpose: 'REPLACEMENT',
          expiresAt: expiresAt.toISOString(),
        });
        return {
          enrollmentId,
          nonce: bufferToHex(nonce),
          expiresAt: expiresAt.toISOString(),
          status: 'REQUESTED' as const,
          purpose: 'REPLACEMENT' as const,
        };
      },
      { auditLock: true },
    );
  }

  /** GET /recovery/enrollments/{id} (ambas apps, sesión de cuenta). */
  async view(userId: string, enrollmentId: string): Promise<EnrollmentView> {
    return view(await this.#load(this.#d.db, userId, enrollmentId), this.#now());
  }

  /** POST /recovery/enrollments/{id}/enrollment-key (Recovery, ENROLLMENT): se registra una sola vez. */
  async registerKey(actor: WalletActor, enrollmentId: string, jwk: P256PublicJwk): Promise<EnrollmentView> {
    const { db } = this.#d;
    return withTransaction(
      db,
      async (trx) => {
        const row = await this.#load(trx, actor.userId, enrollmentId, { forUpdate: true });
        this.#requireEnrollmentSession(actor, row);
        this.#requireOpen(row);
        const thumbprint = jwkThumbprint(jwk);
        if (row.enrollment_key_jwk !== null) {
          if (jwkThumbprint(row.enrollment_key_jwk as P256PublicJwk) !== thumbprint) {
            throw new ApiError('CONFLICT', { detail: 'el enrollment ya tiene otra Enrollment Key' });
          }
          return view(row, this.#now());
        }
        const updated = await trx
          .updateTable('recovery_metadata')
          .set({ enrollment_key_jwk: JSON.stringify(jwk) })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#audit(trx, actor, row.wallet_id, enrollmentId, 'RECOVERY_ENROLLMENT_KEY_REGISTERED', {
          enrollmentKeyThumbprint: thumbprint,
        });
        return view(updated, this.#now());
      },
      { auditLock: true },
    );
  }

  /** POST /recovery/enrollments/{id}/submit (Recovery, ENROLLMENT): R con su prueba de control. */
  async submit(
    actor: WalletActor,
    enrollmentId: string,
    input: {
      enrollment: RecoveryEnrollment;
      enrollmentKeySignature: string;
      rType: 'INTERNAL' | 'EXTERNAL';
      connectorId?: string | undefined;
      proofOfControl: Hex;
      storageFlags?: StorageFlags | undefined;
      /** Sólo en el reemplazo de R: KeyAcceptance de R' con el nonce del enrollment. */
      keyAcceptance?: { nonce: Hex; signature: Hex } | undefined;
    },
  ): Promise<EnrollmentView> {
    const { db, platformId, chainId } = this.#d;
    const snapshot = this.#d.snapshot();
    const row = await this.#load(db, actor.userId, enrollmentId);
    this.#requireEnrollmentSession(actor, row);
    this.#requireOpen(row);
    const jwk = row.enrollment_key_jwk as P256PublicJwk | null;
    if (jwk === null) throw new ApiError('CONFLICT', { detail: 'falta registrar la Enrollment Key' });
    if (input.rType === 'EXTERNAL' && input.connectorId === undefined) {
      throw new ApiError('VALIDATION_FAILED', { detail: 'una R externa requiere connectorId' });
    }
    if (input.rType === 'INTERNAL' && input.storageFlags === undefined) {
      throw new ApiError('VALIDATION_FAILED', { detail: 'una R interna requiere sus backups (storageFlags)' });
    }
    const replacement = row.purpose === 'REPLACEMENT';
    if (replacement !== (input.keyAcceptance !== undefined)) {
      throw new ApiError('VALIDATION_FAILED', {
        detail: replacement
          ? "el reemplazo de R requiere la KeyAcceptance de R'"
          : 'la KeyAcceptance sólo corresponde al reemplazo de R',
      });
    }

    const e = input.enrollment;
    const now = this.#now();
    const issuedAt = Date.parse(e.issuedAt);
    const expiresAt = Date.parse(e.expiresAt);
    const mismatch =
      e.userId !== actor.userId ||
      e.platformId !== platformId ||
      row.nonce === null ||
      e.nonce !== bufferToHex(row.nonce) ||
      Number.isNaN(issuedAt) ||
      Number.isNaN(expiresAt) ||
      issuedAt > now + CLOCK_SKEW_SECONDS * 1000 ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > ENROLLMENT_OBJECT_MAX_SECONDS * 1000;
    if (mismatch) {
      throw new ApiError('CONFLICT', { detail: 'el RecoveryEnrollment no corresponde a este enrollment o venció' });
    }
    if (!verifyP256(jwk, canonicalJson(e), input.enrollmentKeySignature)) {
      throw new ApiError('SIGNATURE_INVALID', { detail: 'firma de la Enrollment Key inválida' });
    }
    const recoveryKey = getAddress(e.R);
    const digest = platformDigest(chainId, snapshot.contracts.walletFactory, 'RecoveryProofOfControl', {
      userId: actor.userId,
      platformId,
      enrollmentId,
      recoveryKey,
    });
    let signer: Address;
    try {
      signer = await recoverStrictSigner(digest, input.proofOfControl);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        throw new ApiError('SIGNATURE_INVALID', { detail: `prueba de control de R inválida (${error.reason})` });
      }
      throw error;
    }
    if (!isAddressEqual(signer, recoveryKey)) {
      throw new ApiError('SIGNATURE_INVALID', { detail: 'la prueba de control no la firmó R' });
    }
    if (input.keyAcceptance !== undefined) {
      const ka = input.keyAcceptance;
      if (row.nonce === null || ka.nonce.toLowerCase() !== bufferToHex(row.nonce)) {
        throw new ApiError('CONFLICT', { detail: 'la KeyAcceptance no lleva el nonce de este enrollment' });
      }
      const accepted = await keyAcceptanceValid(snapshot, {
        walletId: row.wallet_id,
        role: 'R',
        newKey: recoveryKey,
        nonce: ka.nonce,
        signature: ka.signature,
      });
      if (!accepted) throw new ApiError('SIGNATURE_INVALID', { detail: "KeyAcceptance inválida para R'" });
    }
    // R tiene que ser una EOA ([F-KEY-09]): sin código o con un designador EIP-7702 (lectura con quórum).
    const { value: code } = await this.#d.rpc.getCode(recoveryKey);
    const normalized = (code ?? '0x').toLowerCase();
    if (normalized !== '0x' && !EIP7702_DESIGNATOR.test(normalized)) {
      throw new ApiError('KEY_NOT_ALLOWED', { detail: 'R debe ser una EOA (no se aceptan contratos)' });
    }

    const result = await withTransaction(
      db,
      async (trx) => {
        const current = await this.#load(trx, actor.userId, enrollmentId, { forUpdate: true });
        this.#requireOpen(current);
        if (
          current.enrollment_key_jwk === null ||
          jwkThumbprint(current.enrollment_key_jwk as P256PublicJwk) !== jwkThumbprint(jwk)
        ) {
          throw new ApiError('CONFLICT', { detail: 'la Enrollment Key cambió' });
        }
        const keys = await liveKeys(trx, current.wallet_id);
        if (keys.U !== null && isAddressEqual(keys.U, recoveryKey)) {
          throw new ApiError('KEY_NOT_ALLOWED', { detail: 'R no puede ser la misma clave que U' });
        }
        const reuse = replacement ? null : await migrationReuse(trx, current.wallet_id);
        assertMigrationKey(reuse, 'R', recoveryKey);
        await assertKeyUnused(trx, recoveryKey, { walletId: current.wallet_id, role: 'R' }, reuse);
        const updated = await trx
          .updateTable('recovery_metadata')
          .set({
            status: 'SUBMITTED',
            r_address: addressToBuffer(recoveryKey),
            r_type: input.rType,
            connector_id: input.rType === 'EXTERNAL' ? (input.connectorId ?? null) : null,
            enrollment_payload: JSON.stringify(e),
            enrollment_key_signature: Buffer.from(input.enrollmentKeySignature, 'base64url'),
            r_proof_signature: Buffer.from(input.proofOfControl.slice(2), 'hex'),
            storage_flags: input.storageFlags === undefined ? null : JSON.stringify(input.storageFlags),
            key_acceptance: input.keyAcceptance === undefined ? null : JSON.stringify(input.keyAcceptance),
            reused_from_wallet_id: reuse?.role === 'R' ? reuse.fromWalletId : null,
            submitted_at: new Date(this.#now()),
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('wallet_keys_metadata')
          .values({
            wallet_id: current.wallet_id,
            role: 'R',
            key_address: addressToBuffer(recoveryKey),
            key_version: replacement ? await nextKeyVersion(trx, current.wallet_id, 'R') : 1,
            status: 'PENDING',
            source: input.rType === 'INTERNAL' ? 'INTERNAL' : 'EXTERNAL_WALLET',
            storage_flags: JSON.stringify(input.storageFlags ?? {}),
            reused_from_wallet_id: reuse?.role === 'R' ? reuse.fromWalletId : null,
          })
          .execute();
        await this.#audit(trx, actor, current.wallet_id, enrollmentId, 'RECOVERY_ENROLLMENT_SUBMITTED', {
          recoveryKey,
          purpose: current.purpose,
          rType: input.rType,
          ...(input.rType === 'EXTERNAL' ? { connectorId: input.connectorId } : {}),
        });
        return view(updated, this.#now());
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'enrollment', result: 'submitted' });
    return result;
  }

  /**
   * POST /recovery/enrollments/{id}/incorporate (Wallet, ONBOARDING): WalletCreationAuthorization firmada por U. Cada
   * campo tiene que ser exactamente el registrado (R del enrollment, S asignada, salt y Safe esperada).
   */
  async incorporate(
    actor: WalletActor,
    enrollmentId: string,
    input: { authorization: WalletCreationAuthorizationInput; signature: Hex },
  ): Promise<EnrollmentView> {
    const { db, platformId, chainId } = this.#d;
    const snapshot = this.#d.snapshot();
    const result = await withTransaction(
      db,
      async (trx) => {
        const row = await this.#load(trx, actor.userId, enrollmentId, { forUpdate: true });
        const wallet = await walletForActor(trx, platformId, actor, row.wallet_id, { forUpdate: true });
        if (actor.platform.scope !== 'ONBOARDING') throw new ApiError('SCOPE_NOT_ALLOWED');
        if (wallet.status !== 'CREATING') {
          throw new ApiError('CONFLICT', { detail: `la wallet está en ${wallet.status}` });
        }
        const signature = input.signature.toLowerCase();
        if (row.status === 'CONFIRMED') {
          if (row.u_incorporation_signature !== null && bufferToHex(row.u_incorporation_signature) === signature) {
            return { view: view(row, this.#now()), confirmed: false };
          }
          throw new ApiError('CONFLICT', { detail: 'la creación ya está autorizada' });
        }
        if (row.status !== 'SUBMITTED' || row.r_address === null || row.nonce === null) {
          throw new ApiError('CONFLICT', { detail: 'falta que Recovery envíe la clave R' });
        }
        const keys = await liveKeys(trx, wallet.id);
        const executor = await trx
          .selectFrom('signer_keys')
          .select('address')
          .where('wallet_id', '=', wallet.id)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (keys.U === null || !executor || !wallet.expected_safe || wallet.salt_nonce === null) {
          throw new ApiError('CONFLICT', {
            detail: 'falta asignar S y calcular la Safe (POST /wallets/{id}/executor)',
          });
        }
        const a = input.authorization;
        const expected = {
          userId: actor.userId,
          platformId,
          walletId: wallet.id,
          userKey: keys.U,
          recoveryKey: bufferToAddress(row.r_address),
          executor: bufferToAddress(executor.address),
          saltNonce: BigInt(wallet.salt_nonce),
          expectedSafe: bufferToAddress(wallet.expected_safe),
          enrollmentNonce: bufferToHex(row.nonce),
        };
        const fields: string[] = [];
        if (a.userId !== expected.userId) fields.push('userId');
        if (a.platformId !== expected.platformId) fields.push('platformId');
        if (a.walletId !== expected.walletId) fields.push('walletId');
        if (!isAddressEqual(a.userKey, expected.userKey)) fields.push('userKey');
        if (!isAddressEqual(a.recoveryKey, expected.recoveryKey)) fields.push('recoveryKey');
        if (!isAddressEqual(a.executor, expected.executor)) fields.push('executor');
        if (a.saltNonce !== expected.saltNonce.toString()) fields.push('saltNonce');
        if (!isAddressEqual(a.expectedSafe, expected.expectedSafe)) fields.push('expectedSafe');
        if (a.enrollmentNonce.toLowerCase() !== expected.enrollmentNonce) fields.push('enrollmentNonce');
        if (fields.length > 0) {
          throw new ApiError('CONFLICT', {
            detail: `la autorización no coincide con el enrollment o la asignación: ${fields.join(', ')}`,
          });
        }
        let signer: Address;
        try {
          signer = await recoverStrictSigner(
            platformDigest(chainId, snapshot.contracts.walletFactory, 'WalletCreationAuthorization', expected),
            input.signature,
          );
        } catch (error) {
          if (error instanceof InvalidSignatureError) {
            throw new ApiError('SIGNATURE_INVALID', { detail: `firma de U inválida (${error.reason})` });
          }
          throw error;
        }
        if (!isAddressEqual(signer, expected.userKey)) {
          throw new ApiError('SIGNATURE_INVALID', { detail: 'la autorización no la firmó U' });
        }
        const updated = await trx
          .updateTable('recovery_metadata')
          .set({
            status: 'CONFIRMED',
            u_incorporation_signature: Buffer.from(input.signature.slice(2), 'hex'),
            confirmed_at: new Date(this.#now()),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#audit(trx, actor, wallet.id, enrollmentId, 'WALLET_CREATION_AUTHORIZED', {
          userKey: expected.userKey,
          recoveryKey: expected.recoveryKey,
          executor: expected.executor,
          expectedSafe: expected.expectedSafe,
        });
        return { view: view(updated, this.#now()), confirmed: true };
      },
      { auditLock: true },
    );
    if (result.confirmed) this.#d.metrics.walletOnboarding.inc({ step: 'authorization', result: 'ok' });
    return result.view;
  }

  /**
   * POST /recovery/enrollments/{id}/reject (Wallet, con la PlatformSession del pedido: ONBOARDING, u OPERATIONS en el
   * reemplazo de R): la Wallet no pudo confirmar la R de este pedido y lo abortó. Idempotente: un pedido que la Wallet ya
   * rechazó devuelve su estado sin repetir nada; uno reemplazado por un pedido nuevo (SUPERSEDED) toma el motivo de la
   * Wallet, porque el aviso del aborto puede llegar después de que el usuario pidió otro.
   */
  async reject(actor: WalletActor, enrollmentId: string, reason: WalletRejectionReason): Promise<EnrollmentView> {
    const { db, platformId } = this.#d;
    const result = await withTransaction(
      db,
      async (trx) => {
        const row = await this.#load(trx, actor.userId, enrollmentId, { forUpdate: true });
        const wallet = await walletForActor(trx, platformId, actor, row.wallet_id, { forUpdate: true });
        const scope = row.purpose === 'REPLACEMENT' ? 'OPERATIONS' : 'ONBOARDING';
        if (actor.platform.scope !== scope) {
          throw new ApiError('SCOPE_NOT_ALLOWED', { detail: `este pedido se rechaza con una sesión ${scope}` });
        }
        const now = this.#now();
        if (row.status === 'REJECTED' && row.rejection_reason !== null && row.rejection_reason !== 'SUPERSEDED') {
          return { view: view(row, now), rejected: null };
        }
        if (row.status !== 'REQUESTED' && row.status !== 'SUBMITTED' && row.status !== 'REJECTED') {
          throw new ApiError('CONFLICT', { detail: `el enrollment está ${row.status}` });
        }
        const previous = effectiveStatus(row, now);
        const recoveryKey = row.r_address === null ? null : bufferToAddress(row.r_address);
        const updated = await trx
          .updateTable('recovery_metadata')
          .set({ status: 'REJECTED', rejection_reason: reason, rejected_at: new Date(now) })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        // La R que había enviado Recovery para este pedido (el vivo) deja de estar viva: ya no se puede incorporar y,
        // como al pedir otro enrollment, una Safe esperada calculada con ella ya no vale. Un pedido sin R o ya
        // reemplazado no toca nada del pedido vigente.
        if (row.status === 'SUBMITTED' && row.r_address !== null) {
          await trx
            .updateTable('wallet_keys_metadata')
            .set({ status: 'REVOKED', deactivated_at: sql`now()` })
            .where('wallet_id', '=', row.wallet_id)
            .where('role', '=', 'R')
            .where('status', '=', 'PENDING')
            .where('key_address', '=', row.r_address)
            .execute();
          if (row.purpose === 'ONBOARDING' && wallet.status === 'CREATING') {
            await trx
              .updateTable('wallets')
              .set({ expected_safe: null, config_hash: null, updated_at: sql`now()` })
              .where('id', '=', wallet.id)
              .execute();
          }
        }
        const occurredAt = new Date(now).toISOString();
        await this.#audit(trx, actor, row.wallet_id, enrollmentId, 'RECOVERY_ENROLLMENT_REJECTED', {
          reason,
          purpose: row.purpose,
          previousStatus: previous,
          recoveryKey,
        });
        await notify(
          trx,
          {
            userId: actor.userId,
            walletId: row.wallet_id,
            type: 'RECOVERY_ENROLLMENT_REJECTED',
            payload: { enrollmentId, reason, purpose: row.purpose, recoveryKey, occurredAt },
            dedupeKey: `recovery-enrollment-rejected:${enrollmentId}`,
          },
          this.#d.metrics,
        );
        if (this.#d.emails !== null) {
          const user = await trx
            .selectFrom('users')
            .select(['email', 'locale', 'time_zone'])
            .where('id', '=', actor.userId)
            .executeTakeFirstOrThrow();
          await this.#d.emails.enqueue(trx, {
            to: user.email,
            template: 'recovery-enrollment-rejected',
            params: {
              reason,
              purpose: row.purpose,
              recoveryKey,
              // En el onboarding la Safe todavía no existe; en el reemplazo de R es la de la wallet.
              safe:
                row.purpose === 'REPLACEMENT' && wallet.safe_address !== null
                  ? bufferToAddress(wallet.safe_address)
                  : null,
              occurredAt,
              origin: { ipPrefix: actor.meta.ipPrefix, userAgent: actor.meta.userAgent },
            },
            locale: user.locale,
            timeZone: user.time_zone,
            product: 'Wallet',
          });
        }
        return { view: view(updated, now), rejected: { walletId: row.wallet_id, purpose: row.purpose, recoveryKey } };
      },
      { auditLock: true },
    );
    if (result.rejected !== null) {
      this.#d.metrics.recoveryEnrollmentRejections.inc({ reason, purpose: result.rejected.purpose });
      this.#d.logger.error(
        {
          alert: 'RECOVERY_KEY_SUBSTITUTION_SUSPECTED',
          walletId: result.rejected.walletId,
          enrollmentId,
          reason,
          purpose: result.rejected.purpose,
          recoveryKey: result.rejected.recoveryKey,
        },
        'la Wallet rechazó el enrollment de R: posible sustitución de R',
      );
    }
    return result.view;
  }

  async #audit(
    trx: Transaction<Database>,
    actor: WalletActor,
    walletId: string,
    enrollmentId: string,
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
      targetType: 'recovery_enrollment',
      targetId: enrollmentId,
      requestId: actor.meta.requestId,
      ipPrefix: actor.meta.ipPrefix,
      payload: { client: actor.meta.client, platformSessionId: actor.platform.sessionId, ...payload },
    });
  }
}
