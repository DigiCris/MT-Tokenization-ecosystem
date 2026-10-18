// Deploy y activación de una wallet (P12.T06–T07), en el proceso gas-tank a partir del evento WALLET_DEPLOY_REQUESTED.
// Idempotente (un evento puede llegar más de una vez):
//
// - DEPLOYING: si la Safe esperada ya es `isWallet` (deploy anterior o de un tercero, createWallet es permissionless)
//   no se manda otra tx; si no, la cuenta gas tank llama WalletFactory.createWallet(U, R, S, salt) — el backend sólo
//   aporta esos cuatro valores — y se espera el receipt → VERIFYING (safe_address, tx y bloque).
// - VERIFYING: verificación V9 §16 por lectura directa con quórum (wallets/verification.ts). Todo coincide → ACTIVE
//   (claves y registro OPAQUE pasan a ACTIVE) y recién ahí el gas tank fondea S (el signer sólo recarga la S vigente de
//   una Safe registrada); cualquier diferencia → FAILED con el ítem y alerta (la Safe nunca se muestra operativa).
//
// Errores transitorios (RPC, signer) se propagan: el consumidor de la cola reintenta.
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Address, Hex } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { walletFactoryAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database, WalletStatus } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { GasTankService } from '../gas/gas-tank.ts';
import { addressToBuffer, bufferToAddress, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OpaqueService } from '../platform-session/opaque.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { verifyDeployedWallet, type ExpectedWallet } from './verification.ts';
import { ONBOARDING_KEY_VERSION, type WalletRow } from './wallet-service.ts';

export interface WalletDeployerDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  gasTank: GasTankService;
  snapshot: () => BackendPolicySnapshot;
  opaque: OpaqueService;
  audit: AuditWriter;
  metrics: Metrics;
  logger: Logger;
}

const MAX_REASON = 200;

export class WalletDeployer {
  readonly #d: WalletDeployerDeps;

  constructor(deps: WalletDeployerDeps) {
    this.#d = deps;
  }

  /** Procesa el deploy de una wallet; devuelve el estado en que queda. */
  async handle(walletId: string): Promise<WalletStatus | 'MISSING'> {
    const wallet = await this.#load(walletId);
    if (!wallet) {
      this.#d.logger.warn({ walletId }, 'deploy pedido para una wallet inexistente');
      return 'MISSING';
    }
    if (wallet.status === 'DEPLOYING') await this.#deploy(wallet);
    const afterDeploy = await this.#load(walletId);
    if (afterDeploy?.status === 'VERIFYING') await this.#verify(afterDeploy);
    return (await this.#load(walletId))?.status ?? 'MISSING';
  }

  async #load(walletId: string): Promise<WalletRow | undefined> {
    return this.#d.db.selectFrom('wallets').selectAll().where('id', '=', walletId).executeTakeFirst();
  }

  async #expected(wallet: WalletRow): Promise<{ expected: ExpectedWallet; attestation: string }> {
    const keys = await this.#d.db
      .selectFrom('wallet_keys_metadata')
      .select(['role', 'key_address'])
      .where('wallet_id', '=', wallet.id)
      .where('status', 'in', ['PENDING', 'ACTIVE'])
      .execute();
    const signer = await this.#d.db
      .selectFrom('signer_keys')
      .select(['address', 'attestation'])
      .where('wallet_id', '=', wallet.id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    const key = (role: 'U' | 'R' | 'S') => {
      const row = keys.find((k) => k.role === role);
      if (!row) throw new Error(`la wallet ${wallet.id} no tiene clave ${role} viva`);
      return bufferToAddress(row.key_address);
    };
    if (!wallet.expected_safe || wallet.salt_nonce === null || !signer?.attestation) {
      throw new Error(`la wallet ${wallet.id} no tiene Safe esperada, salt o S atestada`);
    }
    const executor = key('S');
    if (bufferToAddress(signer.address) !== executor)
      throw new Error(`la S de ${wallet.id} no coincide con signer_keys`);
    return {
      expected: {
        safe: bufferToAddress(wallet.expected_safe),
        userKey: key('U'),
        recoveryKey: key('R'),
        executor,
        saltNonce: BigInt(wallet.salt_nonce),
      },
      attestation: signer.attestation,
    };
  }

  async #isWallet(safe: Address): Promise<boolean> {
    const { value } = await this.#d.rpc.readContract({
      address: this.#d.snapshot().contracts.walletFactory,
      abi: walletFactoryAbi,
      functionName: 'isWallet',
      args: [safe],
    });
    return value;
  }

  async #deploy(wallet: WalletRow): Promise<void> {
    const { expected, attestation } = await this.#expected(wallet);
    let txHash: Hex | null = null;
    let deployedBy: 'gas-tank' | 'existing' = 'existing';
    if (!(await this.#isWallet(expected.safe))) {
      const tx = await this.#d.gasTank.deploySafe({
        walletId: wallet.id,
        userKey: expected.userKey,
        recoveryKey: expected.recoveryKey,
        executor: expected.executor,
        saltNonce: expected.saltNonce,
        executorAttestation: attestation,
      });
      if (tx.status === 'FAILED' && !(await this.#isWallet(expected.safe))) {
        await this.#fail(wallet.id, ['DEPLOY_REVERTED'], { txHash: tx.txHash });
        return;
      }
      txHash = tx.txHash;
      deployedBy = 'gas-tank';
    }
    const block = txHash === null ? null : await this.#txBlock(txHash);
    await withTransaction(
      this.#d.db,
      async (trx) => {
        const updated = await trx
          .updateTable('wallets')
          .set({
            status: 'VERIFYING',
            safe_address: addressToBuffer(expected.safe),
            deploy_tx_hash: txHash === null ? null : hexToBuffer(txHash, 32),
            deploy_block_number: block,
            updated_at: sql`now()`,
          })
          .where('id', '=', wallet.id)
          .where('status', '=', 'DEPLOYING')
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) return;
        await this.#audit(trx, wallet, 'WALLET_DEPLOYED', { safe: expected.safe, txHash, deployedBy });
      },
      { auditLock: true },
    );
    this.#d.metrics.walletOnboarding.inc({ step: 'deploy', result: deployedBy });
  }

  async #txBlock(txHash: Hex): Promise<string | null> {
    const row = await this.#d.db
      .selectFrom('chain_transactions')
      .select('block_number')
      .where('tx_hash', '=', hexToBuffer(txHash, 32))
      .executeTakeFirst();
    return row?.block_number ?? null;
  }

  async #verify(wallet: WalletRow): Promise<void> {
    const snapshot = this.#d.snapshot();
    const { expected } = await this.#expected(wallet);
    const result = await verifyDeployedWallet(this.#d.rpc, snapshot, expected);
    if (!result.ok) {
      await this.#fail(wallet.id, result.failures, { blockNumber: result.blockNumber.toString() });
      return;
    }
    const activated = await withTransaction(
      this.#d.db,
      async (trx) => {
        const updated = await trx
          .updateTable('wallets')
          .set({ status: 'ACTIVE', activated_at: sql`now()`, updated_at: sql`now()` })
          .where('id', '=', wallet.id)
          .where('status', '=', 'VERIFYING')
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) return false;
        await trx
          .updateTable('wallet_keys_metadata')
          .set({ status: 'ACTIVE', activated_at: sql`now()` })
          .where('wallet_id', '=', wallet.id)
          .where('status', '=', 'PENDING')
          .execute();
        await this.#d.opaque.activate(trx, { walletId: wallet.id, keyVersion: ONBOARDING_KEY_VERSION });
        await this.#audit(trx, wallet, 'WALLET_ACTIVATED', {
          safe: expected.safe,
          verifiedAtBlock: result.blockNumber.toString(),
        });
        return true;
      },
      { auditLock: true },
    );
    if (!activated) return;
    this.#d.metrics.walletOnboarding.inc({ step: 'verify', result: 'active' });
    this.#d.logger.info({ walletId: wallet.id, safe: expected.safe }, 'wallet ACTIVE');
    // Fondeo inicial de S (monto objetivo de la policy). Si falla, la pasada periódica del gas tank lo reintenta.
    try {
      await this.#d.gasTank.topUp({ safe: expected.safe, executor: expected.executor, reason: 'onboarding' });
    } catch (error) {
      this.#d.logger.warn({ walletId: wallet.id, err: error }, 'fondeo inicial de S pendiente');
    }
  }

  async #fail(walletId: string, failures: readonly string[], details: Record<string, unknown>): Promise<void> {
    const reason = failures.join(',').slice(0, MAX_REASON);
    for (const item of failures) this.#d.metrics.walletVerificationFailures.inc({ item });
    this.#d.metrics.walletOnboarding.inc({ step: 'verify', result: 'failed' });
    // Alerta: una Safe que no verifica nunca se presenta como operativa.
    this.#d.logger.error({ walletId, failures, ...details }, 'la wallet no pasó la verificación: FAILED');
    await withTransaction(
      this.#d.db,
      async (trx) => {
        const wallet = await trx.selectFrom('wallets').selectAll().where('id', '=', walletId).executeTakeFirst();
        if (!wallet || (wallet.status !== 'DEPLOYING' && wallet.status !== 'VERIFYING')) return;
        await trx
          .updateTable('wallets')
          .set({ status: 'FAILED', failure_reason: reason, updated_at: sql`now()` })
          .where('id', '=', walletId)
          .execute();
        await this.#audit(trx, wallet, 'WALLET_VERIFICATION_FAILED', { failures, ...details });
      },
      { auditLock: true },
    );
  }

  async #audit(
    trx: Transaction<Database>,
    wallet: WalletRow,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: 'gas-tank',
      userId: wallet.user_id,
      walletId: wallet.id,
      eventType,
      targetType: 'wallet',
      targetId: wallet.id,
      payload,
    });
  }
}

/** Handler de la cola `gas-tank` (proceso gas-tank): WALLET_DEPLOY_REQUESTED → WalletDeployer. */
export function walletDeployJobHandler(
  deployer: WalletDeployer,
): (data: { eventType: string; payload: unknown }) => Promise<void> {
  return async (data) => {
    if (data.eventType !== 'WALLET_DEPLOY_REQUESTED')
      throw new Error(`evento sin handler en gas-tank: ${data.eventType}`);
    const walletId = (data.payload as { walletId?: unknown } | null)?.walletId;
    if (typeof walletId !== 'string') throw new Error('WALLET_DEPLOY_REQUESTED sin walletId');
    await deployer.handle(walletId);
  };
}
