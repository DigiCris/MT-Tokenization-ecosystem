// POST /v1/sign-safe-tx [B-SIG-02] (P11.T03): el signer repite INDEPENDIENTEMENTE los pasos 2–8 (incluido 7b) de
// [B-Q-02] con su propio RPC, su propia DB y su propia policy, y recién entonces firma con S la SafeTx (EIP-712) y la
// tx EIP-1559 `execTransaction`, simula con eth_call y registra el estado. Orden:
//
//  0. reglas estáticas [B-SIG-06] (sin E/S) y versión del snapshot de policy;
//  1. hash de la SafeTx recalculado desde los campos;
//  2. PlatformSession + envelope de envío (validez al momento del envío, ≤ 24 h) y pausa por integridad;
//  3. firma U/R ECDSA estricta;
//  4. estado on-chain a un bloque común (quórum): roles del Guard, nonce, configuración de la Safe (7b);
//  5. hechos de la operación (saldos, whitelist, migración, atestaciones, emparejamiento, propuestas) y policy;
//  6. pre-check `evaluateAssisted` del Guard;
//  7. regla "una SafeTx activa por (safe, nonce)";
//  8. firma S de la SafeTx → simulación de execTransaction → firma S de la tx EIP-1559 → registro → respuesta.
//
// Cualquier falla devuelve un error tipificado y la firma S nunca sale del signer.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { bytesToHex, type Hex, isHex } from '../crypto/bytes.ts';
import { checksumAddress, isAddress, sameAddress, type Address } from '../crypto/keccak.ts';
import { recoverStrict, StrictSignatureError } from '../crypto/secp256k1.ts';
import type { PinnedKeys } from '../crypto/jws.ts';
import { keyAcceptanceDigest } from '../chain/eip712.ts';
import { eip1559SigningHash, execTransactionData, packSignatures, signedEip1559 } from '../chain/exec-tx.ts';
import { safeConfigProblems, type OnChainReader, type SafeState } from '../chain/reader.ts';
import { CallRevertedError, RpcQuorumError } from '../chain/rpc.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import { SignerError } from '../api/errors.ts';
import type { Logger } from '../observability/logger.ts';
import type { SignerMetrics } from '../observability/metrics.ts';
import { verifyChallengeCompletion, verifyIntegrity, verifySignerKeyAttestation } from '../policy/attestations.ts';
import { evaluatePolicy, type PolicyFacts } from '../policy/evaluate.ts';
import { OPERATION_TYPES, OWNER_ROLES, ROLE_ENUM, ROTATION_KINDS, type RotationKind } from '../policy/operations.ts';
import {
  SessionError,
  SubmissionEnvelopeSchema,
  verifyPlatformSessionToken,
  verifySubmission,
} from '../policy/session.ts';
import type { PolicySnapshot } from '../policy/snapshot.ts';
import {
  checkExecutorTxStatic,
  checkSafeTxStatic,
  StaticRuleViolation,
  type TypedOperation,
} from '../policy/static-rules.ts';
import type { SelfHostedSoftwareSignerProvider } from '../providers/SelfHostedSoftwareSignerProvider.ts';
import type { SignerDatabase } from '../state/schema.ts';
import { SignedSafeTxStore } from '../state/signed-txs.ts';

const address = z
  .string()
  .refine((v) => isAddress(v), 'dirección inválida')
  .transform((v) => checksumAddress(v));
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform((v) => BigInt(v));
const hex = z.string().refine((v) => isHex(v), 'hex inválido') as unknown as z.ZodType<Hex>;
const hex65 = z.string().refine((v) => isHex(v, 65), 'firma de 65 bytes') as unknown as z.ZodType<Hex>;
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);

export const SafeTxSchema = z
  .object({
    to: address,
    value: uint,
    data: hex,
    operation: z.number().int().min(0).max(255),
    safeTxGas: uint,
    baseGas: uint,
    gasPrice: uint,
    gasToken: address,
    refundReceiver: address,
    nonce: uint,
  })
  .strict();

const EnvelopeFields = {
  operationId: z.uuid(),
  safeTx: SafeTxSchema,
  ownerSignature: hex65,
  submissionEnvelope: SubmissionEnvelopeSchema,
  submissionEnvelopeSignature: z.string().max(200),
};

export const SignSafeTxRequestSchema = z
  .object({
    ...EnvelopeFields,
    walletId: z.uuid(),
    safe: address,
    chainId: z.number().int(),
    operationType: z.enum(OPERATION_TYPES),
    ownerRole: z.enum(OWNER_ROLES),
    platformSessionToken: z.string().min(1).max(8_192),
    challengeAttestation: z.string().max(8_192).optional(),
    keyAcceptance: z
      .object({ walletId: z.uuid(), role: z.number().int(), newKey: address, nonce: bytes32, signature: hex65 })
      .strict()
      .optional(),
    newKeyAttestation: z.string().max(8_192).optional(),
    pairedSafeTx: z.object(EnvelopeFields).strict().optional(),
    replacesSafeTxHash: bytes32.optional(),
    integrityAttestation: z.string().max(8_192).optional(),
    policySnapshotVersion: z.number().int().positive(),
    execution: z
      .object({ accountNonce: uint, maxFeePerGas: uint, maxPriorityFeePerGas: uint, gasLimit: uint.optional() })
      .strict(),
  })
  .strict();
export type SignSafeTxRequest = z.infer<typeof SignSafeTxRequestSchema>;

export interface SignSafeTxResponse {
  operationId: string;
  safeTxHash: Hex;
  executor: Address;
  sSignature: Hex;
  signedTx: Hex;
  txHash: Hex;
  accountNonce: string;
  gasLimit: string;
}

export interface SignSafeTxDeps {
  db: Kysely<SignerDatabase>;
  provider: SelfHostedSoftwareSignerProvider;
  reader: OnChainReader;
  snapshot: () => PolicySnapshot;
  appEnv: 'local' | 'staging' | 'production';
  issuerKeys: PinnedKeys;
  attestationKeys: PinnedKeys;
  integrity: { required: boolean; monitorKeys: PinnedKeys };
  logger: Logger;
  metrics?: SignerMetrics;
  now?: () => number;
}

const GAS_MARGIN_NUM = 13n;
const GAS_MARGIN_DEN = 10n;

function sessionError(error: SessionError): SignerError {
  return new SignerError(error.problem === 'SIGNATURE_STALE' ? 'SIGNATURE_STALE' : 'SESSION_INVALID', error.problem);
}

function rpcError(error: unknown): never {
  if (error instanceof RpcQuorumError) {
    throw new SignerError(error.problem === 'RPC_DISAGREEMENT' ? 'RPC_DISAGREEMENT' : 'RPC_UNAVAILABLE');
  }
  throw error;
}

export class SignSafeTxService {
  readonly #deps: SignSafeTxDeps;
  readonly #store: SignedSafeTxStore;

  constructor(deps: SignSafeTxDeps) {
    this.#deps = deps;
    this.#store = new SignedSafeTxStore(deps.db);
  }

  #now(): number {
    return this.#deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async sign(request: SignSafeTxRequest): Promise<SignSafeTxResponse> {
    try {
      return await this.#sign(request);
    } catch (error) {
      if (error instanceof SignerError) {
        this.#deps.metrics?.rejections.inc({
          reason: error.reason === undefined ? error.code : `${error.code}:${error.reason}`,
        });
        this.#deps.logger.warn(
          {
            operationId: request.operationId,
            walletId: request.walletId,
            safe: request.safe,
            code: error.code,
            reason: error.reason,
          },
          'firma S rechazada',
        );
      }
      throw error;
    }
  }

  async #sign(req: SignSafeTxRequest): Promise<SignSafeTxResponse> {
    const snapshot = this.#deps.snapshot();
    const { provider, reader } = this.#deps;

    // 0. Reglas estáticas (sin E/S) y versión del snapshot.
    let op: TypedOperation;
    try {
      op = checkSafeTxStatic(snapshot, req);
    } catch (error) {
      if (error instanceof StaticRuleViolation) throw new SignerError('STATIC_RULE_VIOLATION', error.rule);
      throw error;
    }
    if (req.policySnapshotVersion !== snapshot.version) {
      throw new SignerError('POLICY_VERSION_MISMATCH', `vigente ${snapshot.version}`);
    }
    if (!provider.ready) throw new SignerError('SIGNER_NOT_READY');

    // 1. Hash recalculado.
    const hashBytes = safeTxHash(snapshot.chainId, req.safe, req.safeTx);
    const hash = bytesToHex(hashBytes);
    const now = this.#now();

    // 2. PlatformSession + envelope + integridad.
    let claims;
    try {
      claims = await verifyPlatformSessionToken(req.platformSessionToken, this.#deps.issuerKeys, snapshot.platformId);
      verifySubmission({
        claims,
        envelope: req.submissionEnvelope,
        envelopeSignature: req.submissionEnvelopeSignature,
        operationId: req.operationId,
        walletId: req.walletId,
        safe: req.safe,
        safeTxHash: hash,
        now,
        maxAgeSeconds: snapshot.session.maxSignatureAgeSeconds,
        clockSkewSeconds: snapshot.session.clockSkewSeconds,
      });
    } catch (error) {
      if (error instanceof SessionError) throw sessionError(error);
      throw error;
    }
    if (this.#deps.integrity.required) {
      const app = claims.scope === 'RECOVERY' ? 'RECOVERY' : 'WALLET';
      const ok = await verifyIntegrity(req.integrityAttestation, this.#deps.integrity.monitorKeys, {
        platformId: snapshot.platformId,
        environment: this.#deps.appEnv,
        app,
        now,
        clockSkewSeconds: snapshot.session.clockSkewSeconds,
      });
      if (!ok) throw new SignerError('INTEGRITY_PAUSED', app);
    }

    // 3. Firma U/R estricta.
    let owner: Address;
    try {
      owner = recoverStrict(hashBytes, req.ownerSignature);
    } catch (error) {
      if (error instanceof StrictSignatureError) throw new SignerError('OWNER_SIGNATURE_INVALID', error.problem);
      throw error;
    }

    // 4. Estado on-chain (quórum) a un bloque común.
    let state: SafeState;
    try {
      const block = await reader.block();
      state = await reader.safeState(req.safe, block);
    } catch (error) {
      if (error instanceof CallRevertedError) throw new SignerError('SAFE_NOT_REGISTERED');
      rpcError(error);
    }
    if (!state.registered || !state.isWallet) throw new SignerError('SAFE_NOT_REGISTERED');
    const roleKey = req.ownerRole === 'U' ? state.roles.userKey : state.roles.recoveryKey;
    if (!sameAddress(owner, roleKey)) throw new SignerError('OWNER_NOT_ROLE', req.ownerRole);
    const configProblems = safeConfigProblems(state, snapshot);
    if (configProblems.length > 0) throw new SignerError('SAFE_CONFIG_MODIFIED', configProblems.join(','));
    if (req.safeTx.nonce > state.nonce) throw new SignerError('NONCE_NOT_REACHED', `on-chain ${state.nonce}`);
    if (req.safeTx.nonce < state.nonce) throw new SignerError('NONCE_CONSUMED', `on-chain ${state.nonce}`);
    const key = (await provider.registry.forWallet(req.walletId)).find(
      (k) => k.purpose === 'EXECUTOR' && k.status === 'ACTIVE' && sameAddress(k.address, state.roles.executor),
    );
    if (key === undefined) throw new SignerError('KEY_NOT_FOUND', 'S vigente de la Safe no está en este shard');

    return await this.#deps.db.transaction().execute(async (trx) => {
      await this.#store.lockSafe(trx, req.safe);
      await this.#store.markConsumed(trx, req.safe, state.nonce);

      // 5. Hechos y policy (el tiempo de las reglas on-chain, como el deadline del swap, es el del bloque leído).
      const facts = await this.#facts(req, op, state, claims.userId, hash, now, trx);
      facts.now = state.timestamp;
      const verdict = evaluatePolicy(snapshot, {
        safe: req.safe,
        role: req.ownerRole,
        scope: claims.scope,
        declaredType: req.operationType,
        safeTx: req.safeTx,
        facts,
      });
      if (verdict.verdict === 'REJECT') throw new SignerError('POLICY_REJECTED', verdict.code);

      // 6. Pre-check del Guard.
      try {
        const pre = await reader.evaluateAssisted(
          req.safe,
          ROLE_ENUM[req.ownerRole],
          req.safeTx.to,
          req.safeTx.value,
          req.safeTx.data,
          state.block,
          state.governingGuard,
        );
        if (!pre.ok) throw new SignerError('GUARD_WOULD_REVERT', pre.reason);
      } catch (error) {
        if (error instanceof SignerError) throw error;
        rpcError(error);
      }

      // 7. Una SafeTx activa por (safe, nonce).
      const active = await this.#store.activeAt(trx, req.safe, req.safeTx.nonce);
      let replaces: string | null = null;
      if (active !== undefined && active.safeTxHash !== hash) {
        const explicit = req.replacesSafeTxHash === active.safeTxHash;
        if (verdict.type !== 'NOOP_CANCEL' && !explicit) {
          throw new SignerError('SAFE_NONCE_CONFLICT', active.safeTxHash);
        }
        replaces = active.id;
      }

      // 8. Firma S de la SafeTx, simulación, firma de la tx EIP-1559 y registro.
      const sSignature = await provider.signDigest(key.keyRef, hashBytes);
      const signatures = packSignatures([
        { signer: owner, signature: req.ownerSignature },
        { signer: state.roles.executor, signature: sSignature.bytes },
      ]);
      const data = execTransactionData(req.safeTx, signatures);
      // La transacción sigue abierta mientras se lee la cadena: un SELECT entre llamadas mantiene cada espera por debajo
      // del idle_in_transaction_session_timeout (cada llamada está acotada por el presupuesto del RPC, chain/rpc.ts).
      const keepAlive = async () => {
        await sql`SELECT 1`.execute(trx);
      };
      const execution = await this.#execution(req, state.roles.executor, data, snapshot, keepAlive);
      const params = {
        chainId: snapshot.chainId,
        nonce: req.execution.accountNonce,
        to: req.safe,
        value: 0n,
        data,
        gasLimit: execution.gasLimit,
        maxFeePerGas: req.execution.maxFeePerGas,
        maxPriorityFeePerGas: req.execution.maxPriorityFeePerGas,
      };
      try {
        checkExecutorTxStatic(snapshot, { ...params, chainId: params.chainId }, req.safe);
      } catch (error) {
        if (error instanceof StaticRuleViolation) throw new SignerError('STATIC_RULE_VIOLATION', error.rule);
        throw error;
      }
      const txSignature = await provider.signDigest(key.keyRef, eip1559SigningHash(params));
      const signed = signedEip1559(params, txSignature);

      const transfer = op.type === 'TRANSFER' ? op : undefined;
      await this.#store.record(trx, {
        safe: req.safe,
        walletId: req.walletId,
        nonce: req.safeTx.nonce,
        safeTxHash: hash,
        operationId: req.operationId,
        opType: verdict.type,
        ownerRole: req.ownerRole,
        token: transfer?.token ?? (op.type === 'SWAP_APPROVE' ? op.token : op.type === 'SWAP' ? op.tokenIn : null),
        amount: transfer?.amount ?? (op.type === 'SWAP_APPROVE' ? op.amount : op.type === 'SWAP' ? op.amountIn : null),
        destination: transfer?.destination ?? null,
        pairedSafeTxHash:
          op.type === 'SWAP_APPROVE' && req.pairedSafeTx !== undefined
            ? bytesToHex(safeTxHash(snapshot.chainId, req.safe, req.pairedSafeTx.safeTx))
            : null,
        executor: state.roles.executor,
        submittedAt: new Date(req.submissionEnvelope.submittedAt * 1000),
        replaces,
        exec: {
          accountNonce: req.execution.accountNonce,
          txHash: signed.hash,
          maxFeePerGas: req.execution.maxFeePerGas,
          maxPriorityFeePerGas: req.execution.maxPriorityFeePerGas,
          gasLimit: execution.gasLimit,
        },
      });
      this.#deps.metrics?.signatures.inc({ kind: 'safe_tx' });
      this.#deps.logger.info(
        {
          operationId: req.operationId,
          walletId: req.walletId,
          safe: req.safe,
          nonce: req.safeTx.nonce.toString(),
          safeTxHash: hash,
          opType: verdict.type,
          txHash: signed.hash,
        },
        'SafeTx co-firmada por S',
      );
      return {
        operationId: req.operationId,
        safeTxHash: hash,
        executor: state.roles.executor,
        sSignature: sSignature.bytes,
        signedTx: signed.raw,
        txHash: signed.hash,
        accountNonce: req.execution.accountNonce.toString(),
        gasLimit: execution.gasLimit.toString(),
      };
    });
  }

  /** Nonce de cuenta de S, fondos para el gas, simulación de execTransaction y gas. */
  async #execution(
    req: SignSafeTxRequest,
    executor: Address,
    data: Hex,
    snapshot: PolicySnapshot,
    keepAlive: () => Promise<void>,
  ): Promise<{ gasLimit: bigint }> {
    const { rpc } = this.#deps.reader;
    try {
      const onchainNonce = await rpc.transactionCount(executor, 'latest');
      if (req.execution.accountNonce !== onchainNonce) {
        throw new SignerError('ACCOUNT_NONCE_MISMATCH', `on-chain ${onchainNonce}`);
      }
      const call = { from: executor, to: req.safe, data };
      let estimate: bigint;
      try {
        await keepAlive();
        const result = await rpc.simulate(call);
        if (BigInt(result.length > 2 ? result : '0x0') !== 1n)
          throw new SignerError('SIMULATION_REVERTED', 'success = false');
        await keepAlive();
        estimate = await rpc.estimateGas(call);
      } catch (error) {
        if (error instanceof CallRevertedError) throw new SignerError('SIMULATION_REVERTED');
        throw error;
      }
      const cap = BigInt(snapshot.gas.maxGasLimit);
      let gasLimit: bigint;
      if (req.execution.gasLimit !== undefined) {
        if (req.execution.gasLimit < estimate) throw new SignerError('STATIC_RULE_VIOLATION', 'SR-14');
        gasLimit = req.execution.gasLimit;
      } else {
        gasLimit = (estimate * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
        if (gasLimit > cap) gasLimit = estimate <= cap ? cap : estimate;
      }
      const block = await rpc.snapshotBlock();
      const funds = await rpc.balance(executor, block);
      if (funds < gasLimit * req.execution.maxFeePerGas) {
        throw new SignerError('INSUFFICIENT_GAS_FUNDS', `${executor} sin ETH suficiente para el gas`);
      }
      return { gasLimit };
    } catch (error) {
      if (error instanceof SignerError) throw error;
      rpcError(error);
    }
  }

  /** Hechos de la operación para la policy (lecturas a `state.block`). */
  async #facts(
    req: SignSafeTxRequest,
    op: TypedOperation,
    state: SafeState,
    userId: string,
    hash: Hex,
    now: number,
    trx: Parameters<SignedSafeTxStore['lockSafe']>[0],
  ): Promise<PolicyFacts> {
    const snapshot = this.#deps.snapshot();
    const { reader } = this.#deps;
    const block = state.block;
    const c = snapshot.contracts;
    const facts: PolicyFacts = {
      now,
      roles: { userKey: state.roles.userKey, recoveryKey: state.roles.recoveryKey, executor: state.roles.executor },
      dailyOutflowUsed: 0n,
    };
    try {
      switch (op.type) {
        case 'TRANSFER': {
          const [balance, whitelisted, migration, ledger] = await Promise.all([
            reader.tokenBalance(op.token, req.safe, block),
            reader.isWhitelisted(c.destinationWhitelist, req.safe, op.destination, block),
            reader.isMigrationAuthorized(c.policyRegistry, req.safe, op.destination, block),
            this.#store.dailyOutflow(trx, req.safe, req.safeTx.nonce, hash),
          ]);
          facts.balance = balance;
          facts.destinationWhitelisted = whitelisted;
          facts.migrationAuthorized = migration;
          // Por nonce sólo una SafeTx puede ejecutarse: cuenta el mayor entre lo ya firmado en este nonce y ésta.
          facts.dailyOutflowUsed = ledger.others + (ledger.atNonce > op.amount ? ledger.atNonce - op.amount : 0n);
          if (req.challengeAttestation !== undefined && op.amount >= snapshot.limits.twoFactorThreshold) {
            facts.twoFactorVerified = await verifyChallengeCompletion(req.challengeAttestation, this.#deps.issuerKeys, {
              type: 'HIGH_VALUE_TX',
              action: 'SEND',
              userId,
              safe: req.safe,
              safeTxHash: hash,
              nonce: req.safeTx.nonce,
              destination: op.destination,
              token: op.token,
              amount: op.amount,
              now,
              maxAgeSeconds: snapshot.session.maxSignatureAgeSeconds,
              clockSkewSeconds: snapshot.session.clockSkewSeconds,
            });
          }
          return facts;
        }
        case 'SWAP_APPROVE': {
          facts.balance = await reader.tokenBalance(op.token, req.safe, block);
          facts.pairedSwap = await this.#pairedSwap(req, state, userId, now);
          return facts;
        }
        case 'SWAP': {
          const [balance, allowance, paired] = await Promise.all([
            reader.tokenBalance(op.tokenIn, req.safe, block),
            reader.allowance(op.tokenIn, req.safe, op.executor, block),
            req.safeTx.nonce === 0n
              ? Promise.resolve(false)
              : this.#store.approvalPairedWith(trx, req.safe, req.safeTx.nonce - 1n, hash),
          ]);
          facts.balance = balance;
          facts.allowance = allowance;
          facts.approvalSigned = paired;
          return facts;
        }
        case 'WHITELIST_ADD':
          facts.whitelistChallengeVerified =
            req.challengeAttestation !== undefined &&
            (await verifyChallengeCompletion(req.challengeAttestation, this.#deps.issuerKeys, {
              type: 'WHITELIST_ADD',
              action: 'WHITELIST_ADD',
              userId,
              safe: req.safe,
              safeTxHash: hash,
              nonce: req.safeTx.nonce,
              destination: op.destination,
              now,
              maxAgeSeconds: snapshot.session.maxSignatureAgeSeconds,
              clockSkewSeconds: snapshot.session.clockSkewSeconds,
            }));
          return facts;
        case 'ROTATION_PROPOSE': {
          facts.safeTimelock = state.timelock;
          if (op.kind === 'GUARD' || op.kind === 'MODULE_GUARD') {
            facts.currentGuard = state.guard;
            facts.currentModuleGuard = state.moduleGuard;
            const successor = await reader.successorOf(c.policyRegistry, op.kind, op.oldValue, block);
            facts.successorRegistered = sameAddress(successor, op.newValue);
            return facts;
          }
          await this.#newKeyFacts(req, facts, op.kind, op.newValue);
          return facts;
        }
        case 'ROTATION_EXECUTE': {
          const kind = (['U', 'R', 'S'] as const).find((k) =>
            sameAddress(
              k === 'U' ? state.roles.userKey : k === 'R' ? state.roles.recoveryKey : state.roles.executor,
              op.oldOwner,
            ),
          );
          const index = state.owners.findIndex((o) => sameAddress(o, op.oldOwner));
          const expectedPrev = index <= 0 ? '0x0000000000000000000000000000000000000001' : state.owners[index - 1];
          facts.prevOwnerCorrect = index >= 0 && expectedPrev !== undefined && sameAddress(expectedPrev, op.prevOwner);
          if (kind !== undefined) {
            const kindEnum = Number(Object.entries(ROTATION_KINDS).find(([, v]) => v === kind)?.[0]);
            const id = await reader.executableProposal(
              state.timelock,
              req.safe,
              kindEnum,
              op.oldOwner,
              op.newOwner,
              block,
            );
            facts.rotationExecutable = id !== null;
            await this.#newKeyFacts(req, facts, kind, op.newOwner);
          }
          return facts;
        }
        case 'GUARD_UPGRADE': {
          const current = op.target === 'GUARD' ? state.guard : state.moduleGuard;
          const kindEnum = op.target === 'GUARD' ? 3 : 4;
          const [successor, id] = await Promise.all([
            reader.successorOf(c.policyRegistry, op.target, current, block),
            reader.executableProposal(state.timelock, req.safe, kindEnum, current, op.newValue, block),
          ]);
          facts.successorRegistered = sameAddress(successor, op.newValue);
          facts.guardUpgradeMature = id !== null;
          return facts;
        }
        case 'NOOP_CANCEL':
        case 'APPROVE_REVOKE':
        case 'WHITELIST_REMOVE':
          return facts;
      }
    } catch (error) {
      if (error instanceof SignerError) throw error;
      rpcError(error);
    }
  }

  /** Rotación hacia una nueva clave: S sólo hacia claves de un signer; U/R sólo con KeyAcceptance válido. */
  async #newKeyFacts(req: SignSafeTxRequest, facts: PolicyFacts, kind: RotationKind, newKey: Address): Promise<void> {
    if (kind === 'S') {
      const attestation = await verifySignerKeyAttestation(req.newKeyAttestation, this.#deps.attestationKeys, {
        walletId: req.walletId,
        executor: newKey,
      });
      facts.newKeyIsSignerKey = attestation !== undefined;
      return;
    }
    if (kind !== 'U' && kind !== 'R') return;
    const ka = req.keyAcceptance;
    if (
      ka === undefined ||
      ka.walletId !== req.walletId ||
      ka.role !== ROLE_ENUM[kind] ||
      !sameAddress(ka.newKey, newKey)
    ) {
      facts.keyAcceptanceValid = false;
      return;
    }
    const snapshot = this.#deps.snapshot();
    try {
      const digest = keyAcceptanceDigest(snapshot.chainId, snapshot.contracts.walletFactory, {
        walletId: ka.walletId,
        role: ka.role,
        newKey: ka.newKey,
        nonce: ka.nonce,
      });
      facts.keyAcceptanceValid = sameAddress(recoverStrict(digest, ka.signature), newKey);
    } catch {
      facts.keyAcceptanceValid = false;
    }
  }

  /** SWAP N+1 que acompaña a un SWAP_APPROVE: envelope de la misma sesión y firma de U vigente. */
  async #pairedSwap(
    req: SignSafeTxRequest,
    state: SafeState,
    userId: string,
    now: number,
  ): Promise<{ safeTx: SafeTx; ownerSignatureValid: boolean } | null> {
    const paired = req.pairedSafeTx;
    if (paired === undefined) return null;
    const snapshot = this.#deps.snapshot();
    const hashBytes = safeTxHash(snapshot.chainId, req.safe, paired.safeTx);
    try {
      const claims = await verifyPlatformSessionToken(
        req.platformSessionToken,
        this.#deps.issuerKeys,
        snapshot.platformId,
      );
      if (claims.userId !== userId) return { safeTx: paired.safeTx, ownerSignatureValid: false };
      verifySubmission({
        claims,
        envelope: paired.submissionEnvelope,
        envelopeSignature: paired.submissionEnvelopeSignature,
        operationId: paired.operationId,
        walletId: req.walletId,
        safe: req.safe,
        safeTxHash: bytesToHex(hashBytes),
        now,
        maxAgeSeconds: snapshot.session.maxSignatureAgeSeconds,
        clockSkewSeconds: snapshot.session.clockSkewSeconds,
      });
      return {
        safeTx: paired.safeTx,
        ownerSignatureValid: sameAddress(recoverStrict(hashBytes, paired.ownerSignature), state.roles.userKey),
      };
    } catch {
      return { safeTx: paired.safeTx, ownerSignatureValid: false };
    }
  }
}
