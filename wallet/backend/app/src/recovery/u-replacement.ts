// "Perdí U / Password U" (P15.T04, V9 §14): con la cuenta recuperada y el step-up U_REPLACEMENT ([W-07]: sólo en la
// app Wallet), el usuario genera U' en el navegador y registra su dirección, el KDF público, los backups confirmados,
// el registro OPAQUE de la Password U' (PENDING: la U vigente sigue desbloqueando la wallet hasta que la rotación se
// ejecute on-chain) y la KeyAcceptance de U' [W-01]. Queda un borrador de rotación de U (DRAFT) que R propone desde
// Recovery; tras las 48 h, R ejecuta y la sincronización activa el registro OPAQUE de U'.
//
// Rechazo (P17.MAN, [F-LNK-04], ESC-41): la U′ del borrador la informa el backend, y uno comprometido podría cambiarla
// por una U″ suya. La app Recovery no la muestra hasta que coincide con la que el usuario copia de la app Wallet; si no
// coincide en sus intentos, Recovery lo informa con la sesión RECOVERY con la que firmaría la propuesta. El borrador
// queda REJECTED con el motivo (ya no se puede proponer) y su U′ deja de estar viva; como puede ser una sustitución de
// U′ en el camino, queda auditado, el usuario recibe una notificación y un email de seguridad (uno por ventana y usuario;
// el resto en un resumen) y se registra la alerta, como en el rechazo de un enrollment de R por la Wallet
// (enrollment.ts). Si después la Wallet registra otra U′, es un borrador nuevo.
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Database, RotationRequestsTable, UReplacementRejectionReason } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { isUuid } from '../operations/wallet-access.ts';
import { OpaqueProtocolError, type OpaqueService } from '../platform-session/opaque.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { keyAcceptanceValid } from '../rotations/facts.ts';
import { rotationView, type RotationView } from '../rotations/service.ts';
import type { KdfParams, StorageFlags } from '../wallets/schemas.ts';
import { assertKeyUnused, nextKeyVersion, walletForActor, type WalletActor } from '../wallets/wallet-service.ts';
import { rejectionEmailSlot } from './rejection-email.ts';

/**
 * Motivos con los que la app Recovery cancela un borrador del reemplazo de U ([F-LNK-04]): la dirección que el usuario
 * copió de la app Wallet no coincidió con la U′ del borrador en los intentos de la comparación.
 */
export const U_REPLACEMENT_REJECTION_REASONS = [
  'MANUAL_COMPARISON_FAILED',
] as const satisfies readonly UReplacementRejectionReason[];

/** Una rotación de U en curso (desde que se preparó la propuesta hasta que se ejecuta). */
const ROTATION_IN_PROGRESS = [
  'AWAITING_SIGNATURE',
  'PROPOSING',
  'PENDING_TIMELOCK',
  'READY_TO_EXECUTE',
  'EXECUTING',
] as const satisfies readonly RotationRequestsTable['status'][];

export interface UReplacementDeps {
  db: Kysely<Database>;
  platformId: string;
  opaque: OpaqueService;
  audit: AuditWriter;
  emails: EmailOutbox;
  snapshot: () => BackendPolicySnapshot;
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
}

type RotationRow = Selectable<RotationRequestsTable>;

export interface UReplacementResult {
  rotationId: string;
  walletId: string;
  userKey: Address;
  keyVersion: number;
  status: 'DRAFT';
}

export class UReplacementService {
  readonly #d: UReplacementDeps;

  constructor(deps: UReplacementDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** POST /recovery/u-replacement (scope U_REPLACEMENT). */
  async register(
    actor: WalletActor,
    input: {
      userKey: Address;
      kdfParams: KdfParams;
      storageFlags: StorageFlags;
      registrationRecord: string;
      keyAcceptance: { nonce: Hex; signature: Hex };
    },
  ): Promise<UReplacementResult> {
    if (actor.platform.scope !== 'U_REPLACEMENT' || actor.platform.walletId === null) {
      throw new ApiError('SCOPE_NOT_ALLOWED');
    }
    const walletId = actor.platform.walletId;
    const userKey = getAddress(input.userKey);
    const accepted = await keyAcceptanceValid(this.#d.snapshot(), {
      walletId,
      role: 'U',
      newKey: userKey,
      nonce: input.keyAcceptance.nonce,
      signature: input.keyAcceptance.signature,
    });
    if (!accepted) throw new ApiError('SIGNATURE_INVALID', { detail: 'KeyAcceptance inválida para U nueva' });
    const result = await withTransaction(
      this.#d.db,
      async (trx) => {
        const wallet = await walletForActor(trx, this.#d.platformId, actor, walletId, { forUpdate: true });
        if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
        // La misma versión que devolvió el paso 1 del registro OPAQUE (el identificador OPAQUE la incluye).
        const keyVersion = await nextKeyVersion(trx, walletId, 'U');
        const current = await trx
          .selectFrom('wallet_keys_metadata')
          .select('key_address')
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'U')
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (!current) throw new ApiError('WALLET_NOT_ACTIVE', { detail: 'la wallet no tiene una U vigente' });
        const oldKey = bufferToAddress(current.key_address);
        if (isAddressEqual(oldKey, userKey))
          throw new ApiError('KEY_NOT_ALLOWED', { detail: 'U nueva igual a la vigente' });
        const live = await trx
          .selectFrom('rotation_requests')
          .select('id')
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'U')
          .where('status', 'in', ROTATION_IN_PROGRESS)
          .executeTakeFirst();
        if (live) throw new ApiError('CONFLICT', { detail: 'ya hay una rotación de U en curso' });
        // Un borrador anterior se reemplaza: su U' pendiente queda revocada. Uno que la app Recovery rechazó (REJECTED)
        // no se toca: el registro nuevo es un borrador nuevo.
        const draft = await trx
          .selectFrom('rotation_requests')
          .select(['id', 'new_key'])
          .where('wallet_id', '=', walletId)
          .where('role', '=', 'U')
          .where('status', '=', 'DRAFT')
          .forUpdate()
          .executeTakeFirst();
        if (draft) {
          await trx
            .updateTable('wallet_keys_metadata')
            .set({ status: 'REVOKED', deactivated_at: sql`now()` })
            .where('wallet_id', '=', walletId)
            .where('role', '=', 'U')
            .where('status', '=', 'PENDING')
            .execute();
        }
        await assertKeyUnused(trx, userKey, { walletId, role: 'U' });
        await trx
          .insertInto('wallet_keys_metadata')
          .values({
            wallet_id: walletId,
            role: 'U',
            key_address: addressToBuffer(userKey),
            key_version: keyVersion,
            status: 'PENDING',
            source: 'INTERNAL',
            kdf_params: JSON.stringify(input.kdfParams),
            storage_flags: JSON.stringify(input.storageFlags),
          })
          .execute();
        let opaqueRecordId: string;
        try {
          opaqueRecordId = await this.#d.opaque.storeRegistration(trx, {
            userId: actor.userId,
            walletId,
            keyVersion,
            registrationRecord: input.registrationRecord,
          });
        } catch (error) {
          if (error instanceof OpaqueProtocolError) throw new ApiError('VALIDATION_FAILED', { detail: error.message });
          throw error;
        }
        const values = {
          new_key: addressToBuffer(userKey),
          key_acceptance: JSON.stringify(input.keyAcceptance),
          opaque_record_id: opaqueRecordId,
          failure_reason: null,
        };
        const rotationId = draft
          ? (
              await trx
                .updateTable('rotation_requests')
                .set(values)
                .where('id', '=', draft.id)
                .returning('id')
                .executeTakeFirstOrThrow()
            ).id
          : (
              await trx
                .insertInto('rotation_requests')
                .values({
                  wallet_id: walletId,
                  role: 'U',
                  old_key: addressToBuffer(oldKey),
                  initiated_by: 'R',
                  status: 'DRAFT',
                  ...values,
                })
                .returning('id')
                .executeTakeFirstOrThrow()
            ).id;
        const user = await trx
          .selectFrom('users')
          .select(['email', 'locale', 'time_zone'])
          .where('id', '=', actor.userId)
          .executeTakeFirstOrThrow();
        const safe = bufferToAddress(wallet.safe_address);
        const occurredAt = new Date().toISOString();
        await notify(
          trx,
          {
            userId: actor.userId,
            walletId,
            type: 'RECOVERY_STARTED',
            payload: { rotationId, safe, action: 'U_REPLACEMENT', newKey: userKey, occurredAt },
          },
          this.#d.metrics,
        );
        await this.#d.emails.enqueue(trx, {
          to: user.email,
          template: 'recovery-started',
          params: {
            safe,
            action: 'reemplazo de tu clave de usuario (U) con tu clave de recuperación (R)',
            occurredAt,
            origin: { ipPrefix: actor.meta.ipPrefix, userAgent: actor.meta.userAgent },
          },
          locale: user.locale,
          timeZone: user.time_zone,
          product: 'Wallet',
        });
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId,
          sessionId: actor.platform.sessionId,
          eventType: 'RECOVERY_U_REPLACEMENT_STARTED',
          targetType: 'rotation',
          targetId: rotationId,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: { oldKey, newKey: userKey, keyVersion, storageFlags: input.storageFlags },
        });
        return { rotationId, keyVersion };
      },
      { auditLock: true },
    );
    return { rotationId: result.rotationId, walletId, userKey, keyVersion: result.keyVersion, status: 'DRAFT' };
  }

  /**
   * POST /recovery/u-replacement/{id}/reject (Recovery, scope RECOVERY: la misma sesión con la que R firmaría la
   * propuesta): la U′ del borrador no coincidió con la que el usuario copió de la app Wallet ([F-LNK-04]). `newKey` es la
   * U′ que comparó Recovery: si la Wallet registró otra en el mismo borrador, es otra comparación (409, sin efectos).
   * Idempotente: un borrador ya rechazado devuelve su estado sin repetir nada. Con la rotación hacia esa U′ en curso el
   * rechazo no se acepta (409, auditado y con alerta: hay que cancelar la rotación con R); en cualquier otro estado, 409.
   * Una rotación de otra wallet, de otro usuario o que no es de U → 404.
   */
  async reject(
    actor: WalletActor,
    rotationId: string,
    input: { reason: UReplacementRejectionReason; newKey: Address },
  ): Promise<RotationView> {
    if (actor.platform.scope !== 'RECOVERY' || actor.platform.walletId === null) {
      throw new ApiError('SCOPE_NOT_ALLOWED');
    }
    if (!isUuid(rotationId)) throw new ApiError('NOT_FOUND');
    const walletId = actor.platform.walletId;
    const { reason } = input;
    const result = await withTransaction(
      this.#d.db,
      async (trx) => {
        // El mismo orden de locks que el registro de U′: la wallet y después el borrador.
        const wallet = await walletForActor(trx, this.#d.platformId, actor, walletId, { forUpdate: true });
        const row = await trx
          .selectFrom('rotation_requests')
          .selectAll()
          .where('id', '=', rotationId)
          .where('wallet_id', '=', wallet.id)
          .where('role', '=', 'U')
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new ApiError('NOT_FOUND');
        const safe = wallet.safe_address === null ? null : bufferToAddress(wallet.safe_address);
        const view = (current: RotationRow) => rotationView(current, safe, this.#d.snapshot());
        const newKey = bufferToAddress(row.new_key);
        if (!isAddressEqual(newKey, input.newKey)) {
          throw new ApiError('CONFLICT', {
            detail: 'la app Wallet registró otra clave U nueva en este pedido: hay que volver a compararla',
          });
        }
        if (row.status === 'REJECTED') return { view: view(row), rejected: null, refused: null };
        const oldKey = bufferToAddress(row.old_key);
        const inProgress = ROTATION_IN_PROGRESS.find((status) => status === row.status);
        if (inProgress !== undefined) {
          await this.#audit(trx, actor, wallet.id, row.id, 'U_REPLACEMENT_REJECTION_REFUSED', {
            reason,
            oldKey,
            newKey,
            rotationStatus: inProgress,
          });
          return { view: view(row), rejected: null, refused: { newKey, rotationStatus: inProgress } };
        }
        if (row.status !== 'DRAFT') throw new ApiError('CONFLICT', { detail: `la rotación está en ${row.status}` });

        const now = this.#now();
        // Un email por ventana y usuario (rejection-email.ts); los demás de la ventana, en el resumen.
        const email = await rejectionEmailSlot(trx, actor.userId, now, 'U_REPLACEMENT');
        const updated = await trx
          .updateTable('rotation_requests')
          .set({
            status: 'REJECTED',
            rejection_reason: reason,
            rejected_at: new Date(now),
            rejection_email: email,
            rejection_emailed_at: email === 'SENT' ? new Date(now) : null,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        // U′ deja de estar viva: su metadato pendiente y el registro OPAQUE de su Password U′ (nunca se activan).
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'REVOKED', deactivated_at: sql`now()` })
          .where('wallet_id', '=', wallet.id)
          .where('role', '=', 'U')
          .where('status', '=', 'PENDING')
          .where('key_address', '=', row.new_key)
          .execute();
        if (row.opaque_record_id !== null) {
          await trx
            .updateTable('opaque_records')
            .set({ status: 'RETIRED' })
            .where('id', '=', row.opaque_record_id)
            .where('status', '=', 'PENDING')
            .execute();
        }
        const occurredAt = new Date(now).toISOString();
        await this.#audit(trx, actor, wallet.id, row.id, 'U_REPLACEMENT_REJECTED', { reason, oldKey, newKey, email });
        await notify(
          trx,
          {
            userId: actor.userId,
            walletId: wallet.id,
            type: 'U_REPLACEMENT_REJECTED',
            payload: { rotationId: row.id, reason, newKey, safe, occurredAt },
            dedupeKey: `u-replacement-rejected:${row.id}`,
          },
          this.#d.metrics,
        );
        if (email === 'SENT') {
          const user = await trx
            .selectFrom('users')
            .select(['email', 'locale', 'time_zone'])
            .where('id', '=', actor.userId)
            .executeTakeFirstOrThrow();
          await this.#d.emails.enqueue(trx, {
            to: user.email,
            template: 'u-replacement-rejected',
            params: {
              reason,
              newKey,
              safe,
              occurredAt,
              origin: { ipPrefix: actor.meta.ipPrefix, userAgent: actor.meta.userAgent },
            },
            locale: user.locale,
            timeZone: user.time_zone,
            product: 'Recovery',
          });
        }
        return { view: view(updated), rejected: { newKey, email }, refused: null };
      },
      { auditLock: true },
    );
    if (result.refused !== null) {
      this.#d.logger.error(
        {
          alert: 'USER_KEY_SUBSTITUTION_SUSPECTED',
          walletId,
          rotationId,
          reason,
          newKey: result.refused.newKey,
          rotationStatus: result.refused.rotationStatus,
        },
        'la app Recovery rechazó una U′ con la rotación hacia ella en curso: no se acepta el rechazo (hay que cancelar la rotación)',
      );
      throw new ApiError('CONFLICT', {
        detail: 'hay una rotación de U hacia esta clave en curso: cancelala con R desde la app Recovery',
      });
    }
    const rejected = result.rejected;
    if (rejected !== null) {
      this.#d.metrics.uReplacementRejections.inc({ reason });
      if (rejected.email === 'HELD') {
        this.#d.metrics.emailsSkipped.inc({ template: 'u-replacement-rejected', reason: 'held_for_summary' });
      }
      this.#d.logger.error(
        {
          alert: 'USER_KEY_SUBSTITUTION_SUSPECTED',
          walletId,
          rotationId,
          reason,
          newKey: rejected.newKey,
          email: rejected.email,
        },
        'la app Recovery rechazó el borrador del reemplazo de U: posible sustitución de U′',
      );
    }
    return result.view;
  }

  async #audit(
    trx: Transaction<Database>,
    actor: WalletActor,
    walletId: string,
    rotationId: string,
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
      targetType: 'rotation',
      targetId: rotationId,
      requestId: actor.meta.requestId,
      ipPrefix: actor.meta.ipPrefix,
      payload: { client: actor.meta.client, platformSessionId: actor.platform.sessionId, ...payload },
    });
  }
}
