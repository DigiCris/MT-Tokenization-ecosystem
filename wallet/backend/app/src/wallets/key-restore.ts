// KEY_RESTORE [B-PSES-03] (P12.T01.b): restaurar U en un dispositivo nuevo desde las 17 palabras (sin Password U
// previa) o re-registrar OPAQUE tras rotar OPAQUE_SERVER_SETUP. El step-up de KEY_RESTORE exige, además del código del
// email (y TOTP), la prueba de posesión: firma EIP-712 `KeyRestore {userId, walletId, keyAddress, nonce}` [W-01] de la
// U restaurada, que tiene que ser el rol U vigente on-chain (SecurityGuard.rolesOf por quórum) y la U ACTIVE del
// backend. Con esa PlatformSession sólo se puede reemplazar el registro OPAQUE de esa misma U.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { securityGuardAbi } from '../chain/abis/index.ts';
import { platformDigest } from '../chain/eip712.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { Metrics } from '../observability/metrics.ts';
import { OpaqueProtocolError, type OpaqueService } from '../platform-session/opaque.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { walletForActor, type WalletActor } from './wallet-service.ts';

export interface KeyRestoreDeps {
  db: Kysely<Database>;
  platformId: string;
  chainId: number;
  snapshot: () => BackendPolicySnapshot;
  rpc: RpcQuorumClient;
  opaque: OpaqueService;
  audit: AuditWriter;
  metrics: Metrics;
}

export class KeyRestoreService {
  readonly #d: KeyRestoreDeps;

  constructor(deps: KeyRestoreDeps) {
    this.#d = deps;
  }

  /** U ACTIVE (dirección y versión) de una wallet ACTIVE del usuario, con su Safe. */
  async #activeUser(
    userId: string,
    walletId: string,
  ): Promise<{ safe: Address; userKey: Address; keyVersion: number }> {
    const row = await this.#d.db
      .selectFrom('wallets as w')
      .innerJoin('wallet_keys_metadata as k', (j) =>
        j.onRef('k.wallet_id', '=', 'w.id').on('k.role', '=', 'U').on('k.status', '=', 'ACTIVE'),
      )
      .select(['w.safe_address', 'k.key_address', 'k.key_version'])
      .where('w.id', '=', walletId)
      .where('w.user_id', '=', userId)
      .where('w.platform_id', '=', this.#d.platformId)
      .where('w.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!row?.safe_address) throw new ApiError('WALLET_NOT_ACTIVE');
    return {
      safe: bufferToAddress(row.safe_address),
      userKey: bufferToAddress(row.key_address),
      keyVersion: row.key_version,
    };
  }

  /** Prueba de posesión del step-up: firma KeyRestore de la U vigente on-chain (y del backend). */
  async verifyProof(input: {
    userId: string;
    walletId: string;
    keyAddress: Address;
    nonce: Hex;
    signature: Hex;
  }): Promise<void> {
    const snapshot = this.#d.snapshot();
    const active = await this.#activeUser(input.userId, input.walletId);
    let signer: Address;
    try {
      signer = await recoverStrictSigner(
        platformDigest(this.#d.chainId, snapshot.contracts.walletFactory, 'KeyRestore', {
          userId: input.userId,
          walletId: input.walletId,
          keyAddress: input.keyAddress,
          nonce: input.nonce,
        }),
        input.signature,
      );
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        throw new ApiError('SIGNATURE_INVALID', { detail: `firma KeyRestore inválida (${error.reason})` });
      }
      throw error;
    }
    if (!isAddressEqual(signer, input.keyAddress)) {
      throw new ApiError('SIGNATURE_INVALID', { detail: 'la firma KeyRestore no es de keyAddress' });
    }
    const { value: roles } = await this.#d.rpc.readContract({
      address: snapshot.contracts.securityGuard,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [active.safe],
    });
    if (!isAddressEqual(roles.userKey, input.keyAddress) || !isAddressEqual(active.userKey, input.keyAddress)) {
      this.#d.metrics.walletOnboarding.inc({ step: 'key_restore', result: 'not_current_u' });
      throw new ApiError('KEY_NOT_ALLOWED', { detail: 'la clave no es la U vigente de la wallet' });
    }
  }

  /**
   * POST /wallets/{id}/user-key/restore: nuevo registro OPAQUE para la misma U (misma versión), ACTIVE en el acto (el
   * anterior se retira). La PlatformSession KEY_RESTORE se revoca al usarse.
   */
  async restore(
    actor: WalletActor,
    walletId: string,
    registrationRecord: string,
  ): Promise<{ userKey: Address; keyVersion: number; status: 'ACTIVE' }> {
    const active = await this.#activeUser(actor.userId, walletId);
    await withTransaction(
      this.#d.db,
      async (trx) => {
        const wallet = await walletForActor(trx, this.#d.platformId, actor, walletId, { forUpdate: true });
        if (wallet.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE');
        try {
          await this.#d.opaque.storeRegistration(trx, {
            userId: actor.userId,
            walletId,
            keyVersion: active.keyVersion,
            registrationRecord,
          });
        } catch (error) {
          if (error instanceof OpaqueProtocolError) throw new ApiError('VALIDATION_FAILED', { detail: error.message });
          throw error;
        }
        await this.#d.opaque.activate(trx, { walletId, keyVersion: active.keyVersion });
        await trx
          .updateTable('platform_sessions')
          .set({ revoked_at: sql`now()` })
          .where('id', '=', actor.platform.sessionId)
          .execute();
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId,
          sessionId: actor.platform.accountSessionId,
          eventType: 'KEY_RESTORE_COMPLETED',
          targetType: 'wallet',
          targetId: walletId,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: {
            client: actor.meta.client,
            platformSessionId: actor.platform.sessionId,
            userKey: active.userKey,
            keyVersion: active.keyVersion,
          },
        });
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'key_restore', result: 'ok' });
    return { userKey: active.userKey, keyVersion: active.keyVersion, status: 'ACTIVE' };
  }
}
