// "Perdí U / Password U" (P15.T04, V9 §14): con la cuenta recuperada y el step-up U_REPLACEMENT ([W-07]: sólo en la
// app Wallet), el usuario genera U' en el navegador y registra su dirección, el KDF público, los backups confirmados,
// el registro OPAQUE de la Password U' (PENDING: la U vigente sigue desbloqueando la wallet hasta que la rotación se
// ejecute on-chain) y la KeyAcceptance de U' [W-01]. Queda un borrador de rotación de U (DRAFT) que R propone desde
// Recovery; tras las 48 h, R ejecuta y la sincronización activa el registro OPAQUE de U'.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import { OpaqueProtocolError, type OpaqueService } from '../platform-session/opaque.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { keyAcceptanceValid } from '../rotations/facts.ts';
import type { KdfParams, StorageFlags } from '../wallets/schemas.ts';
import { assertKeyUnused, nextKeyVersion, walletForActor, type WalletActor } from '../wallets/wallet-service.ts';

export interface UReplacementDeps {
  db: Kysely<Database>;
  platformId: string;
  opaque: OpaqueService;
  audit: AuditWriter;
  emails: EmailOutbox;
  snapshot: () => BackendPolicySnapshot;
  metrics?: Metrics;
}

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
          .where('status', 'in', [
            'AWAITING_SIGNATURE',
            'PROPOSING',
            'PENDING_TIMELOCK',
            'READY_TO_EXECUTE',
            'EXECUTING',
          ])
          .executeTakeFirst();
        if (live) throw new ApiError('CONFLICT', { detail: 'ya hay una rotación de U en curso' });
        // Un borrador anterior se reemplaza: su U' pendiente queda revocada.
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
}
