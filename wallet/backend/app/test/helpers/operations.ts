// Entorno de los tests del pipeline de operaciones (P13) con las piezas reales: el entorno de onboarding (sistema en el
// fork, shards del signer por mTLS, listeners con los servicios de wallets) más una wallet ACTIVE creada por la API,
// la PlatformSession OPERATIONS obtenida con OPAQUE, el pipeline del worker S, el watcher, el indexer y la
// reconciliación. Del lado del cliente: firma EIP-712 de la SafeTx con U (viem) y el envelope de envío firmado con la
// session key P-256 ([B-PSES-06]); del lado de la cadena: fondeo con USDC/USDT reales del fork (holders impersonados) y
// ejecuciones soberanas U+R (el camino que no pasa por la plataforma).
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { destinationWhitelistAbi, iSafeAbi } from '../../src/chain/abis/index.ts';
import { ChainIndexer } from '../../src/chain/indexer.ts';
import type { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { Reconciler } from '../../src/chain/reconciler.ts';
import { safeTxHash, safeTxTypedData, type SafeTx } from '../../src/chain/safe-tx.ts';
import { FinalityWatcher, type ConfirmationPolicy } from '../../src/chain/watcher.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { EmailOutbox } from '../../src/email/email-outbox.ts';
import { createLogger, type Logger } from '../../src/observability/logger.ts';
import { safeTxFromJson, type PreparedOperation } from '../../src/operations/intent.ts';
import type { OperationActor, OperationService, PrepareInput } from '../../src/operations/service.ts';
import { OperationStateMachine } from '../../src/operations/state-machine.ts';
import { submissionCanonical, type SubmissionEnvelope } from '../../src/platform-session/request-signature.ts';
import type { VerifiedPlatformSession } from '../../src/platform-session/sessions.ts';
import { PlatformSessionClaimsSchema, PlatformSessionIssuer } from '../../src/platform-session/token.ts';
import { readSignerTls, SignerClient } from '../../src/signer-client/client.ts';
import { SignerKeyService } from '../../src/signer-client/sharding.ts';
import { SovereignModification } from '../../src/wallets/sovereign.ts';
import { createRedis } from '../../src/queue/redis.ts';
import { SafeLease } from '../../src/worker/lease.ts';
import { startOperationsWorker, type OperationsWorker } from '../../src/worker/main.ts';
import { OperationPipeline, type PipelineOptions } from '../../src/worker/pipeline.ts';
import {
  critical,
  deploy,
  idempotencyKey,
  onboard,
  startOnboardingEnv,
  type OnboardedWallet,
  type OnboardingEnv,
  type Session,
} from './onboarding.ts';
import { testRedisUrl } from './api.ts';
import { signP256, unlockWallet, type UnlockedSession } from './platform.ts';

/** Holders de USDC/USDT en el bloque del fork (los mismos que usa SeedLocal). */
export const USDC_HOLDER: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const USDT_HOLDER: Address = '0x0D0707963952f2fBA59dD06f2b425ace40b492Fe';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Confirmaciones del fork en los tests: pocas para no tener que minar cientos de bloques. */
export const TEST_CONFIRMATIONS: ConfirmationPolicy = { policy: 'depth', confirmationDepth: 2, finalizationDepth: 4 };

/** Pipeline rápido para tests: sondeo corto y reintentos en milisegundos. */
export const FAST_PIPELINE: Partial<PipelineOptions> = {
  pollIntervalMs: 100,
  receiptTimeoutMs: 30_000,
  retry: { baseMs: 50, maxMs: 500, maxRetries: 20 },
};

export interface OperationsEnv {
  base: OnboardingEnv;
  redisDb: number;
  logger: Logger;
  machine: OperationStateMachine;
  operations: OperationService;
  issuer: PlatformSessionIssuer;
  sovereign: SovereignModification;
  chain: ForkChain;
  pipeline: (options?: PipelineFactoryOptions) => OperationPipeline;
  watcher: (confirmations?: ConfirmationPolicy, rpc?: RpcQuorumClient) => FinalityWatcher;
  indexer: () => ChainIndexer;
  reconciler: () => Reconciler;
  close: () => Promise<void>;
}

export interface PipelineFactoryOptions {
  owner?: string;
  leaseTtlMs?: number;
  /** URL alternativa del shard dev-1 (p. ej. detrás de un proxy de fallas). */
  signerUrl?: string;
  options?: Partial<PipelineOptions>;
  now?: () => number;
  logger?: Logger;
  /** Cliente RPC alternativo (p. ej. dual con un proxy de fallas como secundario). */
  rpc?: RpcQuorumClient;
}

export async function startOperationsEnv(options: { redisDb: number; logger?: Logger }): Promise<OperationsEnv> {
  const base = await startOnboardingEnv({
    redisDb: options.redisDb,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const db = base.db.app;
  const wallets = base.wallet.wallets;
  if (wallets === null) throw new Error('el listener de Wallet no tiene los servicios de wallets');
  const audit = base.wallet.services.audit;
  const outbox = new OutboxRepository(db);
  const machine = new OperationStateMachine({ db, audit, outbox });
  const config = base.wallet.config;
  const issuer = await PlatformSessionIssuer.create(
    config.secrets.sessionIssuerPrivateKey,
    config.secrets.sessionIssuerPublicKey,
  );
  const logger = options.logger ?? createLogger({ level: 'silent', service: 'test-operations' });
  const sovereign = new SovereignModification({
    audit,
    email: new EmailOutbox(outbox, config.secrets.fieldEncryptionKey),
    logger,
    metrics: base.metrics,
  });
  const extraClients: SignerClient[] = [];
  const chain = new ForkChain(base.anvil.url, (method, params) => base.anvil.rpc(method, params));
  await chain.init();
  return {
    base,
    redisDb: options.redisDb,
    logger,
    machine,
    operations: wallets.operations,
    issuer,
    sovereign,
    chain,
    pipeline: (p = {}) => {
      const client =
        p.signerUrl === undefined
          ? base.executorShard.client
          : new SignerClient({
              shardId: 'dev-1',
              url: p.signerUrl,
              tls: readSignerTls({ caPath: base.pki.ca, certPath: base.pki.client.cert, keyPath: base.pki.client.key }),
              timeoutMs: 120_000,
            });
      if (p.signerUrl !== undefined) extraClients.push(client);
      return new OperationPipeline({
        db,
        machine,
        audit,
        rpc: p.rpc ?? base.rpc,
        snapshot: () => base.snapshot,
        signers: new SignerKeyService({
          db,
          shards: [{ id: 'dev-1', url: p.signerUrl ?? base.executorShard.url, active: true }],
          clients: new Map([['dev-1', client]]),
        }),
        issuer,
        sovereign,
        lease: new SafeLease(db, p.owner ?? `test-worker-${randomBytes(3).toString('hex')}`, {
          ttlMs: p.leaseTtlMs ?? 30_000,
        }),
        logger: p.logger ?? logger,
        metrics: base.metrics,
        options: { ...FAST_PIPELINE, ...p.options },
        ...(p.now === undefined ? {} : { now: p.now }),
      });
    },
    watcher: (confirmations = TEST_CONFIRMATIONS, rpc = base.rpc) =>
      new FinalityWatcher({ db, machine, audit, rpc, confirmations, logger, metrics: base.metrics }),
    indexer: () =>
      new ChainIndexer({
        db,
        rpc: base.rpc,
        audit,
        snapshot: () => base.snapshot,
        confirmations: TEST_CONFIRMATIONS,
        logger,
        metrics: base.metrics,
      }),
    reconciler: () =>
      new Reconciler({
        db,
        rpc: base.rpc,
        audit,
        snapshot: () => base.snapshot,
        sovereign,
        logger,
        metrics: base.metrics,
      }),
    close: async () => {
      for (const client of extraClients) client.close();
      await base.close();
    },
  };
}

/**
 * Worker de operaciones real (consumidor de la cola `wallet-operations` en la base Valkey del archivo); sin lazos
 * periódicos por defecto: el test llama a `schedule()` o corre watcher/indexer a mano.
 */
export function startWorker(
  env: OperationsEnv,
  options: { pipeline?: OperationPipeline; concurrency?: number; loops?: boolean } = {},
): OperationsWorker & { stop: () => Promise<void> } {
  const connection = createRedis(
    testRedisUrl(env.redisDb),
    'worker',
    `test-operations-${randomBytes(3).toString('hex')}`,
    () => undefined,
  );
  const worker = startOperationsWorker({
    db: env.base.db.app,
    connection,
    outbox: new OutboxRepository(env.base.db.app),
    machine: env.machine,
    pipeline: options.pipeline ?? env.pipeline(),
    operations: env.operations,
    watcher: env.watcher(),
    indexer: env.indexer(),
    reconciler: env.reconciler(),
    logger: env.logger,
    metrics: env.base.metrics,
    options: {
      concurrency: options.concurrency ?? 4,
      schedulerIntervalMs: 250,
      watcherIntervalMs: 500,
      indexerIntervalMs: 500,
      reconcilerIntervalMs: 5_000,
      loops: options.loops ?? false,
    },
  });
  return {
    ...worker,
    stop: async () => {
      await worker.close();
      await connection.quit();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Wallet activa y sesión OPERATIONS

export interface ActiveWallet {
  onboarded: OnboardedWallet;
  walletId: string;
  safe: Address;
  executor: Address;
  userKey: PrivateKeyAccount;
  recoveryKey: PrivateKeyAccount;
  session: UnlockedSession;
  actor: OperationActor;
}

/** Claims de un token de PlatformSession (el payload del JWS; la firma ya la verificó la API al emitirlo). */
export function tokenClaims(token: string) {
  const payload = token.split('.')[1] ?? '';
  return PlatformSessionClaimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
}

export function actorFor(userId: string, session: Pick<UnlockedSession, 'token'>): OperationActor {
  const verified: VerifiedPlatformSession = { token: session.token, claims: tokenClaims(session.token) };
  return { userId, session: verified, meta: { requestId: `test-${randomBytes(4).toString('hex')}`, ipPrefix: null } };
}

/** Onboarding + deploy por la API (S fondeada con ETH) y desbloqueo con OPAQUE → PlatformSession OPERATIONS. */
export async function activeWallet(env: OperationsEnv): Promise<ActiveWallet> {
  const onboarded = await onboard(env.base);
  const status = await deploy(env.base, onboarded);
  if (status !== 'ACTIVE') throw new Error(`deploy terminó en ${status}`);
  const row = await env.base.db.app
    .selectFrom('wallets')
    .select(['safe_address'])
    .where('id', '=', onboarded.walletId)
    .executeTakeFirstOrThrow();
  const safe = `0x${(row.safe_address ?? Buffer.alloc(20)).toString('hex')}`;
  // ETH de sobra para el gas de las tx de S (el gas tank la recarga sólo hasta el objetivo).
  await env.chain.setBalance(onboarded.plan.executor, 10n ** 17n);
  const session = await unlockWallet(onboarded.user.wallet, onboarded.userKey.authSecretHex);
  return {
    onboarded,
    walletId: onboarded.walletId,
    safe: getAddress(safe),
    executor: onboarded.plan.executor,
    userKey: onboarded.userKey.account,
    recoveryKey: onboarded.recoveryKey.account,
    session,
    actor: actorFor(onboarded.user.account.id, session),
  };
}

/** Vuelve a desbloquear (una PlatformSession vale 15 min). */
export async function refreshSession(wallet: ActiveWallet): Promise<void> {
  wallet.session = await unlockWallet(wallet.onboarded.user.wallet, wallet.onboarded.userKey.authSecretHex);
  wallet.actor = actorFor(wallet.onboarded.user.account.id, wallet.session);
}

// ---------------------------------------------------------------------------------------------------------------
// Operaciones: prepare (servicio interno), firma de U y envío por la API

export function noopCall(wallet: ActiveWallet): PrepareInput {
  return { walletId: wallet.walletId, operationType: 'NOOP_CANCEL', call: { to: wallet.safe, data: '0x' } };
}

/** APPROVE_REVOKE: `approve(SwapExecutor, 0)` de USDC (operación de U sin precondiciones de saldo ni whitelist). */
export function revokeCall(env: OperationsEnv, wallet: ActiveWallet, token: 'USDC' | 'USDT' = 'USDC'): PrepareInput {
  return {
    walletId: wallet.walletId,
    operationType: 'APPROVE_REVOKE',
    call: {
      to: env.base.snapshot.tokens[token],
      data: encodeFunctionData({
        abi: approveAbi,
        functionName: 'approve',
        args: [env.base.snapshot.contracts.swapExecutor, 0n],
      }),
    },
  };
}

const approveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export function sendCall(
  env: OperationsEnv,
  wallet: ActiveWallet,
  token: 'USDC' | 'USDT',
  to: Address,
  amount: bigint,
) {
  return {
    walletId: wallet.walletId,
    operationType: 'SEND' as const,
    call: {
      to: env.base.snapshot.tokens[token],
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
    },
  };
}

export function prepare(env: OperationsEnv, wallet: ActiveWallet, input: PrepareInput): Promise<PreparedOperation> {
  return env.operations.prepare(wallet.actor, input);
}

/** Firma EIP-712 de la SafeTx (lo que hace la Wallet con U). */
export async function signSafeTx(
  signer: PrivateKeyAccount,
  prepared: Pick<PreparedOperation, 'safe' | 'safeTx' | 'chainId'>,
) {
  return signer.signTypedData(safeTxTypedData(prepared.chainId, prepared.safe, safeTxFromJson(prepared.safeTx)));
}

export interface SubmissionBody {
  ownerSignature: Hex;
  ownerRole: 'U' | 'R';
  submissionEnvelope: SubmissionEnvelope;
  submissionEnvelopeSignature: string;
}

/** Cuerpo de POST /operations/{id}/signatures: firma de U + envelope de envío firmado con la session key. */
export async function submissionBody(
  wallet: ActiveWallet,
  prepared: Pick<PreparedOperation, 'operationId' | 'safeTxHash' | 'safe' | 'safeTx' | 'chainId'>,
  options: { signer?: PrivateKeyAccount; submittedAt?: number; session?: Pick<Session, 'key' | 'sessionId'> } = {},
): Promise<SubmissionBody> {
  const session = options.session ?? wallet.session;
  const envelope: SubmissionEnvelope = {
    operationId: prepared.operationId,
    safeTxHash: prepared.safeTxHash,
    sessionId: session.sessionId,
    submittedAt: options.submittedAt ?? Math.floor(Date.now() / 1000),
  };
  return {
    ownerSignature: await signSafeTx(options.signer ?? wallet.userKey, prepared),
    ownerRole: 'U',
    submissionEnvelope: envelope,
    submissionEnvelopeSignature: signP256(session.key, submissionCanonical(envelope)),
  };
}

export function submitSignature(wallet: ActiveWallet, operationId: string, body: unknown, key = idempotencyKey()) {
  return critical(wallet.onboarded.user.wallet, sessionOf(wallet), `/operations/${operationId}/signatures`, body, {
    idempotencyKey: key,
  });
}

/** La sesión OPERATIONS de la wallet con la forma que usan los requests críticos de prueba. */
export function sessionOf(wallet: ActiveWallet): Session {
  return {
    token: wallet.session.token,
    sessionId: wallet.session.sessionId,
    key: wallet.session.key,
    walletId: wallet.walletId,
  };
}

/** POST /operations/{id}/cancel con la sesión OPERATIONS. */
export function cancelOperation(wallet: ActiveWallet, operationId: string, key = idempotencyKey()) {
  return critical(
    wallet.onboarded.user.wallet,
    sessionOf(wallet),
    `/operations/${operationId}/cancel`,
    {},
    { idempotencyKey: key },
  );
}

/** prepare + firma + envío; devuelve la operación ya QUEUED. */
export async function queueOperation(
  env: OperationsEnv,
  wallet: ActiveWallet,
  input: PrepareInput,
): Promise<PreparedOperation> {
  const prepared = await prepare(env, wallet, input);
  const response = await submitSignature(wallet, prepared.operationId, await submissionBody(wallet, prepared));
  if (response.statusCode !== 200) throw new Error(`signatures: ${String(response.statusCode)} ${response.body}`);
  return prepared;
}

export async function operationRow(env: OperationsEnv, id: string) {
  return env.base.db.app.selectFrom('wallet_operations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function statusOf(env: OperationsEnv, id: string) {
  return (await operationRow(env, id)).status;
}

export async function auditTypes(env: OperationsEnv, id: string): Promise<string[]> {
  const rows = await env.base.db.app
    .selectFrom('audit_events')
    .select('event_type')
    .where('target_type', '=', 'operation')
    .where('target_id', '=', id)
    .orderBy('id')
    .execute();
  return rows.map((r) => r.event_type);
}

/** Mina bloques y corre el watcher hasta que la operación llegue al estado pedido. */
export async function settle(
  env: OperationsEnv,
  id: string,
  status: 'CONFIRMED' | 'FINALIZED',
  watcher = env.watcher(),
) {
  for (let i = 0; i < 20; i++) {
    await watcher.runOnce();
    if ((await statusOf(env, id)) === status) return;
    await env.chain.mine(1);
  }
  throw new Error(`la operación ${id} no llegó a ${status}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Cadena: fondeo, ejecuciones soberanas y control de Anvil

const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class ForkChain {
  readonly url: string;
  readonly public;
  readonly relayer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  readonly #rpc: <T>(method: string, params?: unknown[]) => Promise<T>;

  constructor(url: string, rpc: <T>(method: string, params?: unknown[]) => Promise<T>) {
    this.url = url;
    this.public = createPublicClient({ chain: base, transport: http(url) });
    this.#rpc = rpc;
  }

  async init(): Promise<void> {
    await this.setBalance(this.relayer.address, 10n ** 20n);
  }

  rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    return this.#rpc<T>(method, params);
  }

  async setBalance(address: Address, wei: bigint): Promise<void> {
    await this.#rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
  }

  async mine(blocks = 1): Promise<void> {
    await this.#rpc('anvil_mine', [`0x${blocks.toString(16)}`]);
  }

  async setAutomine(enabled: boolean): Promise<void> {
    await this.#rpc('evm_setAutomine', [enabled]);
  }

  async increaseTime(seconds: number): Promise<void> {
    await this.#rpc('evm_increaseTime', [seconds]);
    await this.mine(1);
  }

  async blockNumber(): Promise<bigint> {
    return this.public.getBlockNumber({ cacheTime: 0 });
  }

  async safeNonce(safe: Address): Promise<bigint> {
    return this.public.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
  }

  async tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.public.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  }

  /** Transfiere tokens reales del fork desde un holder impersonado. */
  async fund(token: Address, holder: Address, to: Address, amount: bigint): Promise<void> {
    await this.setBalance(holder, 10n ** 19n);
    await this.#rpc('anvil_impersonateAccount', [holder]);
    try {
      const hash = await this.#rpc<Hex>('eth_sendTransaction', [
        {
          from: holder,
          to: token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        },
      ]);
      const receipt = await this.public.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('fondeo revertido');
    } finally {
      await this.#rpc('anvil_stopImpersonatingAccount', [holder]);
    }
  }

  /** Ejecución soberana U+R: el Guard no aplica política en ese camino (la transmite un relayer cualquiera). */
  async execSovereign(safe: Address, tx: { to: Address; data: Hex }, owners: PrivateKeyAccount[]): Promise<Hex> {
    const nonce = await this.safeNonce(safe);
    const safeTx: SafeTx = {
      to: tx.to,
      value: 0n,
      data: tx.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce,
    };
    const hash = safeTxHash(8453, safe, safeTx);
    const signed = await Promise.all(
      owners.map(async (o) => ({ signer: o.address, signature: await o.sign({ hash }) })),
    );
    // Safe exige las firmas ordenadas por dirección del firmante.
    signed.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
    const signatures: Hex = `0x${signed.map((s) => s.signature.slice(2)).join('')}`;
    const wallet = createWalletClient({ account: this.relayer, chain: base, transport: http(this.url) });
    const txHash = await wallet.writeContract({
      address: safe,
      abi: iSafeAbi,
      functionName: 'execTransaction',
      args: [tx.to, 0n, tx.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
      gas: 1_500_000n,
    });
    const receipt = await this.public.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error('ejecución soberana revertida');
    return txHash;
  }

  /** Whitelist de un destino por el camino soberano (U+R) y espera de la activación (24 h en el fork). */
  async whitelistSovereign(
    safe: Address,
    whitelist: Address,
    destination: Address,
    owners: PrivateKeyAccount[],
  ): Promise<void> {
    await this.execSovereign(
      safe,
      {
        to: whitelist,
        data: encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'addDestination', args: [destination] }),
      },
      owners,
    );
    const delay = await this.public.readContract({
      address: whitelist,
      abi: destinationWhitelistAbi,
      functionName: 'ACTIVATION_DELAY',
    });
    await this.increaseTime(Number(delay) + 1);
  }
}
