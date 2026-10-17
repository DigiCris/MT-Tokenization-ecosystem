// POST /v1/sign-platform-tx (shard `platform`) [B-SIG-05]: la cuenta gas tank firma SÓLO
// - recargas de ETH a la S vigente de una Safe registrada (verificado on-chain: SecurityGuard.rolesOf(safe).executor,
//   isRegistered y WalletFactory.isWallet), con tope por recarga y tope diario (ledger propio);
// - `WalletFactory.createWallet(U, R, S, salt)` con una S atestada por un signer (SignerKeyAttestation);
// - `RotationTimelock.cancelWithSignature(id, firma)` (la simulación verifica firma y propuesta pendiente).
// Reglas estáticas GT-xx antes de cualquier E/S; simulación y topes de gas/fees antes de firmar.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { type Hex, isHex } from '../crypto/bytes.ts';
import { checksumAddress, isAddress, sameAddress, type Address } from '../crypto/keccak.ts';
import type { PinnedKeys } from '../crypto/jws.ts';
import { eip1559SigningHash, signedEip1559 } from '../chain/exec-tx.ts';
import type { OnChainReader } from '../chain/reader.ts';
import { CallRevertedError, RpcQuorumError } from '../chain/rpc.ts';
import { SignerError } from '../api/errors.ts';
import type { Logger } from '../observability/logger.ts';
import type { SignerMetrics } from '../observability/metrics.ts';
import { verifySignerKeyAttestation } from '../policy/attestations.ts';
import type { PolicySnapshot } from '../policy/snapshot.ts';
import { checkPlatformTxStatic, StaticRuleViolation } from '../policy/static-rules.ts';
import type { SelfHostedSoftwareSignerProvider } from '../providers/SelfHostedSoftwareSignerProvider.ts';
import type { SignerDatabase } from '../state/schema.ts';

const address = z
  .string()
  .refine((v) => isAddress(v), 'dirección inválida')
  .transform((v) => checksumAddress(v));
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform((v) => BigInt(v));

export const PlatformTxRequestSchema = z
  .object({
    purpose: z.enum(['TOPUP', 'DEPLOY', 'CANCEL_RELAY']),
    chainId: z.number().int(),
    to: address,
    value: uint,
    data: z.string().refine((v) => isHex(v)) as unknown as z.ZodType<Hex>,
    /** TOPUP: la Safe cuya S vigente recibe la recarga. */
    safe: address.optional(),
    /** DEPLOY: SignerKeyAttestation de la S de la Safe a desplegar. */
    executorAttestation: z.string().max(8_192).optional(),
    walletId: z.uuid().optional(),
    reference: z.string().max(128).optional(),
    policySnapshotVersion: z.number().int().positive(),
    execution: z
      .object({ accountNonce: uint, maxFeePerGas: uint, maxPriorityFeePerGas: uint, gasLimit: uint.optional() })
      .strict(),
  })
  .strict();
export type PlatformTxRequest = z.infer<typeof PlatformTxRequestSchema>;

export interface PlatformTxResponse {
  from: Address;
  signedTx: Hex;
  txHash: Hex;
  accountNonce: string;
  gasLimit: string;
}

export interface PlatformTxDeps {
  db: Kysely<SignerDatabase>;
  provider: SelfHostedSoftwareSignerProvider;
  reader: OnChainReader;
  snapshot: () => PolicySnapshot;
  attestationKeys: PinnedKeys;
  logger: Logger;
  metrics?: SignerMetrics;
}

function rpcError(error: unknown): never {
  if (error instanceof RpcQuorumError) {
    throw new SignerError(error.problem === 'RPC_DISAGREEMENT' ? 'RPC_DISAGREEMENT' : 'RPC_UNAVAILABLE');
  }
  throw error;
}

export class PlatformTxService {
  readonly #deps: PlatformTxDeps;

  constructor(deps: PlatformTxDeps) {
    this.#deps = deps;
  }

  async gasTankAddress(): Promise<Address | undefined> {
    return (await this.#deps.provider.registry.gasTankKey())?.address;
  }

  async sign(req: PlatformTxRequest): Promise<PlatformTxResponse> {
    try {
      return await this.#sign(req);
    } catch (error) {
      if (error instanceof SignerError) {
        this.#deps.metrics?.rejections.inc({ reason: `${error.code}:${error.reason ?? ''}` });
        this.#deps.logger.warn(
          { purpose: req.purpose, code: error.code, reason: error.reason },
          'tx del gas tank rechazada',
        );
      }
      throw error;
    }
  }

  async #sign(req: PlatformTxRequest): Promise<PlatformTxResponse> {
    const snapshot = this.#deps.snapshot();
    const { provider, reader } = this.#deps;
    const staticInput = {
      chainId: req.chainId,
      purpose: req.purpose,
      to: req.to,
      value: req.value,
      data: req.data,
      maxFeePerGas: req.execution.maxFeePerGas,
      maxPriorityFeePerGas: req.execution.maxPriorityFeePerGas,
      gasLimit: req.execution.gasLimit ?? BigInt(snapshot.gasTank.maxGasLimit),
    };
    let decoded;
    try {
      decoded = checkPlatformTxStatic(snapshot, staticInput);
    } catch (error) {
      if (error instanceof StaticRuleViolation) throw new SignerError('STATIC_RULE_VIOLATION', error.rule);
      throw error;
    }
    if (req.policySnapshotVersion !== snapshot.version) {
      throw new SignerError('POLICY_VERSION_MISMATCH', `vigente ${snapshot.version}`);
    }
    if (!provider.ready) throw new SignerError('SIGNER_NOT_READY');
    const key = await provider.registry.gasTankKey();
    if (key === undefined) throw new SignerError('KEY_NOT_FOUND', 'el shard no tiene cuenta gas tank');

    return await this.#deps.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('signer:gas-tank', 0))`.execute(trx);
      try {
        const block = await reader.block();
        if (decoded.purpose === 'TOPUP') {
          if (req.safe === undefined) throw new SignerError('PLATFORM_TX_REJECTED', 'TOPUP_SAFE_REQUIRED');
          const state = await reader.safeState(req.safe, block);
          if (!state.registered || !state.isWallet || !sameAddress(state.roles.executor, decoded.to)) {
            throw new SignerError('PLATFORM_TX_REJECTED', 'TOPUP_NOT_EXECUTOR');
          }
          const row = await trx
            .selectFrom('platform_txs')
            .select(sql<string>`coalesce(sum(value_wei), 0)`.as('total'))
            .where('purpose', '=', 'TOPUP')
            .where(sql<boolean>`signed_at > now() - interval '24 hours'`)
            .executeTakeFirstOrThrow();
          if (BigInt(row.total) + decoded.value > snapshot.gasTank.dailyCapWei) {
            throw new SignerError('GAS_TANK_CAP_EXCEEDED', 'tope diario de recargas');
          }
        } else if (decoded.purpose === 'DEPLOY') {
          const attestation = await verifySignerKeyAttestation(req.executorAttestation, this.#deps.attestationKeys, {
            walletId: req.walletId ?? '',
            executor: decoded.executor,
          });
          if (attestation === undefined) throw new SignerError('PLATFORM_TX_REJECTED', 'DEPLOY_EXECUTOR_NOT_ATTESTED');
        }

        const onchainNonce = await reader.rpc.transactionCount(key.address, 'latest');
        if (req.execution.accountNonce !== onchainNonce) {
          throw new SignerError('ACCOUNT_NONCE_MISMATCH', `on-chain ${onchainNonce}`);
        }
        const call = { from: key.address, to: req.to, data: req.data, value: req.value };
        let estimate: bigint;
        try {
          await reader.rpc.simulate(call);
          estimate = await reader.rpc.estimateGas(call);
        } catch (error) {
          if (error instanceof CallRevertedError) throw new SignerError('SIMULATION_REVERTED');
          throw error;
        }
        const gasLimit = req.execution.gasLimit ?? (estimate * 13n) / 10n;
        if (gasLimit < estimate) throw new SignerError('STATIC_RULE_VIOLATION', 'GT-05');
        try {
          checkPlatformTxStatic(snapshot, { ...staticInput, gasLimit });
        } catch (error) {
          if (error instanceof StaticRuleViolation) throw new SignerError('STATIC_RULE_VIOLATION', error.rule);
          throw error;
        }
        const funds = await reader.rpc.balance(key.address, block);
        if (funds < req.value + gasLimit * req.execution.maxFeePerGas) {
          throw new SignerError('INSUFFICIENT_GAS_FUNDS', 'saldo del gas tank insuficiente');
        }
        const params = {
          chainId: snapshot.chainId,
          nonce: req.execution.accountNonce,
          to: req.to,
          value: req.value,
          data: req.data,
          gasLimit,
          maxFeePerGas: req.execution.maxFeePerGas,
          maxPriorityFeePerGas: req.execution.maxPriorityFeePerGas,
        };
        const signature = await provider.signDigest(key.keyRef, eip1559SigningHash(params));
        const signed = signedEip1559(params, signature);
        await trx
          .insertInto('platform_txs')
          .values({
            purpose: req.purpose,
            from_address: key.address.toLowerCase(),
            to_address: req.to.toLowerCase(),
            value_wei: req.value.toString(),
            account_nonce: req.execution.accountNonce.toString(),
            tx_hash: signed.hash.toLowerCase(),
            max_fee_per_gas: req.execution.maxFeePerGas.toString(),
            gas_limit: gasLimit.toString(),
            reference: req.reference ?? null,
          })
          .onConflict((oc) => oc.column('tx_hash').doNothing())
          .execute();
        this.#deps.metrics?.signatures.inc({ kind: 'platform_tx' });
        this.#deps.logger.info(
          {
            purpose: req.purpose,
            to: req.to,
            value: req.value.toString(),
            txHash: signed.hash,
            reference: req.reference,
          },
          'tx del gas tank firmada',
        );
        return {
          from: key.address,
          signedTx: signed.raw,
          txHash: signed.hash,
          accountNonce: req.execution.accountNonce.toString(),
          gasLimit: gasLimit.toString(),
        };
      } catch (error) {
        if (error instanceof SignerError) throw error;
        rpcError(error);
      }
    });
  }
}
