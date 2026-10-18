// Gas tank / relayer del backend [B-SIG-05] (P11.T09). La cuenta gas tank vive en el shard `platform` del signer, que
// firma sólo recargas de ETH a la S vigente de una Safe registrada, `WalletFactory.createWallet` con una S atestada y
// `RotationTimelock.cancelWithSignature`. Este servicio decide qué pedir, transmite a los dos RPC, registra la tx en
// `chain_transactions` (y la recarga en `gas_topups`) y espera el receipt:
//
// - recarga: si una S tiene menos de GAS_TOPUP_MIN_WEI se la lleva a GAS_TOPUP_TARGET_WEI, sin superar el tope diario
//   GAS_TANK_DAILY_CAP_WEI (el signer aplica además su propio tope del snapshot);
// - deploy de Safes y retransmisión de cancelaciones firmadas por U o R.
//
// Una sola tx en vuelo de la cuenta gas tank (lock de la DB + espera del receipt): el signer exige el nonce confirmado.
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { encodeFunctionData, getAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { rotationTimelockAbi, walletFactoryAbi } from '../chain/abis/index.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { Database } from '../db/schema.ts';
import { addressToBuffer, bufferToAddress, hexToBuffer } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { timelocksOf } from '../policy/guards.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import { SignerClientError, type SignerClient } from '../signer-client/client.ts';

export interface GasTankConfig {
  topupMinWei: bigint;
  topupTargetWei: bigint;
  dailyCapWei: bigint;
  receiptTimeoutMs?: number;
}

export interface GasTankDeps {
  db: Kysely<Database>;
  rpc: RpcQuorumClient;
  platform: SignerClient;
  policy: () => BackendPolicySnapshot;
  config: GasTankConfig;
  logger: Logger;
  metrics: Metrics;
}

export type PlatformPurpose = 'TOPUP' | 'DEPLOY' | 'CANCEL_RELAY';

export interface GasTankTx {
  purpose: PlatformPurpose;
  txHash: Hex;
  status: 'MINED' | 'FAILED';
  txId: string;
}

export type TopUpResult =
  ({ toppedUp: true; amount: bigint } & GasTankTx) | { toppedUp: false; reason: 'ABOVE_MINIMUM' | 'DAILY_CAP' };

export class GasTankError extends Error {
  override name = 'GasTankError';
}

export class GasTankService {
  readonly #deps: GasTankDeps;
  #address: Address | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<unknown> | undefined;

  constructor(deps: GasTankDeps) {
    this.#deps = deps;
  }

  async address(): Promise<Address> {
    this.#address ??= getAddress((await this.#deps.platform.gasTankAddress()).address);
    return this.#address;
  }

  async balance(): Promise<bigint> {
    const { value } = await this.#deps.rpc.getBalance(await this.address());
    this.#deps.metrics.gasTankBalanceWei.set(Number(value));
    return value;
  }

  /** Recargado en las últimas 24 h (ledger propio del backend). */
  async toppedUpLastDay(): Promise<bigint> {
    const row = await this.#deps.db
      .selectFrom('gas_topups')
      .select(sql<string>`coalesce(sum(amount_wei), 0)`.as('total'))
      .where(sql<boolean>`created_at > now() - interval '24 hours'`)
      .executeTakeFirstOrThrow();
    return BigInt(row.total);
  }

  /** Recarga la S vigente de una Safe si está bajo el mínimo (hasta el objetivo), dentro del tope diario. */
  async topUp(input: { safe: Address; executor: Address; reason?: string }): Promise<TopUpResult> {
    const { config } = this.#deps;
    const { value: balance } = await this.#deps.rpc.getBalance(input.executor);
    if (balance >= config.topupMinWei) return { toppedUp: false, reason: 'ABOVE_MINIMUM' };
    const amount = config.topupTargetWei - balance;
    if ((await this.toppedUpLastDay()) + amount > config.dailyCapWei) {
      this.#deps.metrics.gasTankTransactions.inc({ purpose: 'TOPUP', result: 'DAILY_CAP' });
      this.#deps.logger.warn(
        { executor: input.executor, amount: amount.toString() },
        'recarga omitida: tope diario del gas tank',
      );
      return { toppedUp: false, reason: 'DAILY_CAP' };
    }
    const tx = await this.#submit('TOPUP', {
      to: input.executor,
      value: amount,
      data: '0x',
      safe: input.safe,
      reference: input.reason ?? 'topup',
    });
    if (tx.status === 'MINED') {
      await this.#deps.db
        .insertInto('gas_topups')
        .values({
          executor_address: addressToBuffer(input.executor),
          amount_wei: amount.toString(),
          tx_id: tx.txId,
          reason: input.reason ?? 'saldo bajo el mínimo',
        })
        .execute();
    }
    return { toppedUp: true, amount, ...tx };
  }

  /** Despliega una Safe por la WalletFactory ([C-FAC-05], permissionless) pagando el gas desde el gas tank. */
  async deploySafe(input: {
    walletId: string;
    userKey: Address;
    recoveryKey: Address;
    executor: Address;
    saltNonce: bigint;
    executorAttestation: string;
  }): Promise<GasTankTx> {
    const data = encodeFunctionData({
      abi: walletFactoryAbi,
      functionName: 'createWallet',
      args: [input.userKey, input.recoveryKey, input.executor, input.saltNonce],
    });
    return this.#submit('DEPLOY', {
      to: this.#deps.policy().contracts.walletFactory,
      value: 0n,
      data,
      walletId: input.walletId,
      executorAttestation: input.executorAttestation,
      reference: input.walletId,
    });
  }

  /**
   * Retransmite una cancelación de rotación firmada por U o R ([C-RTL-03]); cualquiera podría transmitirla. El destino
   * es el RotationTimelock de la propuesta: el del sistema o el de un Guard sucesor fijado en el snapshot.
   */
  async relayCancellation(input: { proposalId: Hex; signature: Hex; timelock?: Address }): Promise<GasTankTx> {
    const timelock = input.timelock ?? this.#deps.policy().contracts.rotationTimelock;
    if (!timelocksOf(this.#deps.policy()).some((t) => t.toLowerCase() === timelock.toLowerCase())) {
      throw new GasTankError('el timelock de la cancelación no está en el snapshot de policy');
    }
    const data = encodeFunctionData({
      abi: rotationTimelockAbi,
      functionName: 'cancelWithSignature',
      args: [input.proposalId, input.signature],
    });
    return this.#submit('CANCEL_RELAY', {
      to: timelock,
      value: 0n,
      data,
      reference: input.proposalId,
    });
  }

  /** Una pasada: recarga las S vigentes de las wallets activas que estén bajo el mínimo. */
  async runOnce(): Promise<{ checked: number; belowMinimum: number; toppedUp: number }> {
    const rows = await this.#deps.db
      .selectFrom('wallets as w')
      .innerJoin('signer_keys as k', (j) => j.onRef('k.wallet_id', '=', 'w.id').on('k.status', '=', 'ACTIVE'))
      .select(['w.safe_address', 'k.address'])
      .where('w.status', '=', 'ACTIVE')
      .where('w.safe_address', 'is not', null)
      .execute();
    let below = 0;
    let topped = 0;
    for (const row of rows) {
      if (row.safe_address === null) continue;
      const executor = bufferToAddress(row.address);
      const result = await this.topUp({
        safe: bufferToAddress(row.safe_address),
        executor,
        reason: 'pasada periódica',
      });
      if (result.toppedUp || result.reason === 'DAILY_CAP') below++;
      if (result.toppedUp) topped++;
    }
    this.#deps.metrics.executorsBelowMinimum.set(below);
    await this.balance();
    return { checked: rows.length, belowMinimum: below, toppedUp: topped };
  }

  start(intervalMs: number): void {
    const tick = () => {
      this.#running ??= this.runOnce()
        .catch((error: unknown) => {
          this.#deps.logger.error({ err: error }, 'pasada del gas tank fallida');
        })
        .finally(() => {
          this.#running = undefined;
        });
    };
    tick();
    this.#timer = setInterval(tick, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** Pide la firma al shard platform, transmite a los dos RPC, registra la tx y espera el receipt. */
  async #submit(
    purpose: PlatformPurpose,
    tx: {
      to: Address;
      value: bigint;
      data: Hex;
      safe?: Address;
      walletId?: string;
      executorAttestation?: string;
      reference: string;
    },
  ): Promise<GasTankTx> {
    const { db, rpc, platform, metrics, logger } = this.#deps;
    const from = await this.address();
    // Una sola tx en vuelo de la cuenta gas tank: lock de sesión en una conexión propia (sin transacción abierta
    // mientras se espera el receipt). La tx queda registrada antes de transmitirse (recuperable tras un corte).
    return db.connection().execute(async (conn) => {
      await sql`SELECT pg_advisory_lock(hashtextextended('mtw:gas-tank', 0))`.execute(conn);
      try {
        const [{ value: accountNonce }, fees] = await Promise.all([rpc.getTransactionCount(from), rpc.feeData()]);
        let signed;
        try {
          signed = await platform.signPlatformTx({
            purpose,
            chainId: this.#deps.policy().chainId,
            to: tx.to,
            value: tx.value.toString(),
            data: tx.data,
            ...(tx.safe === undefined ? {} : { safe: tx.safe }),
            ...(tx.walletId === undefined ? {} : { walletId: tx.walletId }),
            ...(tx.executorAttestation === undefined ? {} : { executorAttestation: tx.executorAttestation }),
            reference: tx.reference,
            policySnapshotVersion: this.#deps.policy().version,
            execution: {
              accountNonce: accountNonce.toString(),
              maxFeePerGas: fees.maxFeePerGas.toString(),
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
            },
          });
          metrics.signerRequests.inc({ shard: platform.shardId, route: 'sign-platform-tx', result: 'ok' });
        } catch (error) {
          const code = error instanceof SignerClientError ? error.code : 'ERROR';
          metrics.signerRequests.inc({ shard: platform.shardId, route: 'sign-platform-tx', result: code });
          metrics.gasTankTransactions.inc({ purpose, result: code });
          throw error;
        }
        const inserted = await conn
          .insertInto('chain_transactions')
          .values({
            chain_id: this.#deps.policy().chainId,
            purpose,
            from_address: addressToBuffer(from),
            account_nonce: signed.accountNonce,
            tx_hash: hexToBuffer(signed.txHash, 32),
            raw_tx: hexToBuffer(signed.signedTx),
            max_fee_per_gas: fees.maxFeePerGas.toString(),
            max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
            gas_limit: signed.gasLimit,
            status: 'BROADCAST',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await rpc.sendRawTransaction(signed.signedTx);
        const receipt = await this.#waitReceipt(signed.txHash);
        const status = receipt.status === 'success' ? 'MINED' : 'FAILED';
        await conn
          .updateTable('chain_transactions')
          .set({
            status,
            block_number: receipt.blockNumber.toString(),
            block_hash: hexToBuffer(receipt.blockHash, 32),
            receipt_status: receipt.status === 'success' ? 1 : 0,
            gas_used: receipt.gasUsed.toString(),
            effective_gas_price: receipt.effectiveGasPrice.toString(),
          })
          .where('id', '=', inserted.id)
          .execute();
        metrics.gasTankTransactions.inc({ purpose, result: status });
        logger.info({ purpose, txHash: signed.txHash, status, reference: tx.reference }, 'tx del gas tank');
        return { purpose, txHash: signed.txHash, status, txId: inserted.id };
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended('mtw:gas-tank', 0))`.execute(conn);
      }
    });
  }

  async #waitReceipt(hash: Hex): Promise<TransactionReceipt> {
    const deadline = Date.now() + (this.#deps.config.receiptTimeoutMs ?? 120_000);
    for (;;) {
      const receipt = await this.#deps.rpc.getTransactionReceipt(hash);
      if (receipt !== null) return receipt;
      if (Date.now() > deadline) throw new GasTankError(`sin receipt para ${hash}`);
      await sleep(500);
    }
  }
}
