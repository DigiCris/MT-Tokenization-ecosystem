// Entorno y lado cliente del onboarding (P12) para los tests, con las mismas piezas reales que en producción: el sistema
// desplegado en el fork (estado del global setup), shards reales del signer (`dev-1` para S y `platform` para el gas
// tank) por mTLS, listeners de Wallet y Recovery con los servicios de wallets, el pipeline de outbox real (BullMQ) con
// el worker de email (Mailpit) y el de la cola `gas-tank` (WalletDeployer), y el cliente: step-up con el código del
// email, OPAQUE con @serenity-kit/opaque, firmas EIP-712 de U y R con viem y la Enrollment Key P-256.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { RpcQuorumClient, RpcQuorumError } from '../../src/chain/rpc-quorum.ts';
import { platformTypedData } from '../../src/chain/eip712.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { GasTankService } from '../../src/gas/gas-tank.ts';
import { canonicalJson } from '../../src/lib/jcs.ts';
import { createLogger, type Logger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { OPAQUE_KEY_STRETCHING } from '../../src/platform-session/opaque.ts';
import { loadPolicySnapshot, type BackendPolicySnapshot } from '../../src/policy/snapshot.ts';
import { createOutboxWorker } from '../../src/queue/outbox-consumer.ts';
import { createRedis } from '../../src/queue/redis.ts';
import { QUEUES } from '../../src/queue/queues.ts';
import { CancelRelayer, gasTankJobHandler } from '../../src/rotations/cancel-relay.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { SignerKeyService } from '../../src/signer-client/sharding.ts';
import { walletDeployJobHandler, WalletDeployer } from '../../src/wallets/deployer.ts';
import { createVerifiedUser, type TestAccount } from './accounts.ts';
import { buildTestListener, testRedis, testRedisUrl, type TestListener } from './api.ts';
import type { TestClient } from './client.ts';
import { testConfig } from './config.ts';
import { createTestDatabase, type TestDatabase } from './db.ts';
import { deployedChain, type DeployedSystem } from './deploy.ts';
import { startEmailPipeline, type EmailPipeline } from './email-pipeline.ts';
import { startAnvil, type AnvilInstance } from './fork.ts';
import { codeFrom, waitForMessage, type MailpitMessage } from './mailpit.ts';
import { newAuthSecret, newSessionKey, signedHeaders, signP256, type SessionKey } from './platform.ts';
import {
  createPki,
  edKey,
  startSignerShard,
  writePolicySnapshot,
  type EdKeyPair,
  type Pki,
  type SignerShard,
  type SnapshotSuccessors,
} from './signer-shard.ts';

await opaque.ready;

/** 0,001 ETH: objetivo de recarga (≤ topupMaxWei del snapshot de prueba). */
export const TOPUP_TARGET = 1_000_000_000_000_000n;

export interface OnboardingEnv {
  db: TestDatabase;
  redis: Redis;
  anvil: AnvilInstance;
  rpc: RpcQuorumClient;
  system: DeployedSystem;
  snapshot: BackendPolicySnapshot;
  /** Archivo del snapshot firmado (y su .sig) que usan los shards y el backend. */
  snapshotPath: string;
  pki: Pki;
  keys: { attestation: EdKeyPair; policy: EdKeyPair; issuer: EdKeyPair };
  executorShard: SignerShard;
  platformShard: SignerShard;
  wallet: TestListener;
  recovery: TestListener;
  pipeline: EmailPipeline;
  gasTank: GasTankService;
  deployer: WalletDeployer;
  /** Retransmisión de cancelaciones de rotación (P15): la consume el mismo worker de la cola `gas-tank`. */
  cancelRelay: CancelRelayer;
  metrics: Metrics;
  /** Arranca el worker de la cola `gas-tank` (por defecto el test corre el deployer a mano). */
  startDeployWorker: () => void;
  close: () => Promise<void>;
}

export async function startOnboardingEnv(options: {
  redisDb: number;
  deployWorker?: boolean;
  /** Sucesores del Guard fijados en el snapshot de policy (P15.T08). */
  snapshotSuccessors?: SnapshotSuccessors;
  /** Logger de los listeners y del deployer (por defecto silencioso; los tests de canario lo capturan). */
  logger?: Logger;
}): Promise<OnboardingEnv> {
  const chain = deployedChain();
  const dir = mkdtempSync(join(tmpdir(), 'mtw-onboarding-'));
  const [anvil, db] = await Promise.all([startAnvil({ loadState: chain.statePath }), createTestDatabase()]);
  const redis = testRedis(options.redisDb);
  await redis.flushdb();
  const logger = options.logger ?? createLogger({ level: 'silent', service: 'test-onboarding' });
  const metrics = createMetrics({ defaultMetrics: false });
  const pki = createPki();
  const keys = { attestation: edKey(), policy: edKey(), issuer: edKey() };
  const snapshotPath = writePolicySnapshot(dir, keys.policy, chain.system, 1, options.snapshotSuccessors);
  const snapshot = loadPolicySnapshot(snapshotPath, keys.policy.publicKey, 'local');
  const [executorShard, platformShard] = await Promise.all([
    startSignerShard({ shardId: 'dev-1', anvilUrl: anvil.url, pki, keys, snapshotPath }),
    startSignerShard({ shardId: 'platform', anvilUrl: anvil.url, pki, keys, snapshotPath }),
  ]);
  const rpc = new RpcQuorumClient({
    primaryUrl: anvil.url,
    secondaryUrl: anvil.url,
    mode: 'local-single',
    chainId: 8453,
    timeoutMs: 30_000,
    healthIntervalMs: 60_000,
    maxHeadLagBlocks: 10,
    retries: 2,
    backoffMs: 100,
    logger,
    metrics,
  });
  const signerKeys = new SignerKeyService({
    db: db.app,
    shards: [{ id: 'dev-1', url: executorShard.url, active: true }],
    clients: new Map([['dev-1', executorShard.client]]),
  });
  // La plataforma y la clave del emisor de sesiones son las que fijan el snapshot y los shards (el signer verifica los
  // tokens de PlatformSession con esa clave pública y exige el platformId del snapshot).
  const config = testConfig({
    RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
    PLATFORM_ID: snapshot.platformId,
    SESSION_ISSUER_PRIVATE_KEY: keys.issuer.privateBase64,
    SESSION_ISSUER_PUBLIC_KEY: keys.issuer.publicBase64,
  });
  const onchain = { rpc, snapshot: () => snapshot };
  const common = { db, config, redis, rpc, onchain, signerKeys, logger, metrics };
  const wallet = await buildTestListener({ ...common, client: 'WALLET' });
  const recovery = await buildTestListener({ ...common, client: 'RECOVERY' });
  const pipeline = await startEmailPipeline({
    db: db.app,
    redisDb: options.redisDb,
    fieldKey: config.secrets.fieldEncryptionKey,
  });
  const gasTank = new GasTankService({
    db: db.app,
    rpc,
    platform: platformShard.client,
    policy: () => snapshot,
    config: {
      topupMinWei: 200_000_000_000_000n,
      topupTargetWei: TOPUP_TARGET,
      dailyCapWei: 3_000_000_000_000_000n,
    },
    logger,
    metrics,
  });
  // La cuenta gas tank arranca con 0,05 ETH (como la fondea el operador).
  await anvil.rpc('anvil_setBalance', [platformShard.created.gasTank, '0xb1a2bc2ec50000']);
  const deployer = new WalletDeployer({
    db: db.app,
    rpc,
    gasTank,
    snapshot: () => snapshot,
    opaque: wallet.services.opaque,
    audit: wallet.services.audit,
    metrics,
    logger,
  });
  const cancelRelay = new CancelRelayer({
    db: db.app,
    rpc,
    gasTank,
    snapshot: () => snapshot,
    audit: wallet.services.audit,
    logger,
  });
  let deployWorker: Worker | undefined;
  let deployConnection: Redis | undefined;
  const startDeployWorker = () => {
    if (deployWorker) return;
    deployConnection = createRedis(testRedisUrl(options.redisDb), 'worker', 'test-gas-tank-worker', () => undefined);
    deployWorker = createOutboxWorker({
      queue: QUEUES.gasTank,
      connection: deployConnection,
      outbox: new OutboxRepository(db.app),
      logger,
      concurrency: 1,
      handler: gasTankJobHandler({ deploy: walletDeployJobHandler(deployer), cancelRelay }),
    });
  };
  if (options.deployWorker) startDeployWorker();
  return {
    db,
    redis,
    anvil,
    rpc,
    system: chain.system,
    snapshot,
    snapshotPath,
    pki,
    keys,
    executorShard,
    platformShard,
    wallet,
    recovery,
    pipeline,
    gasTank,
    deployer,
    cancelRelay,
    metrics,
    startDeployWorker,
    close: async () => {
      await deployWorker?.close();
      await deployConnection?.quit();
      await pipeline.stop();
      await wallet.close();
      await recovery.close();
      await Promise.all([executorShard.stop(), platformShard.stop()]);
      await rpc.stop();
      await redis.quit();
      await db.close();
      await anvil.stop();
      pki.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lado cliente

export interface Session {
  token: string;
  sessionId: string;
  key: SessionKey;
  walletId: string | null;
}

/** Usuario con sesión en Wallet (y, si se pide, también en Recovery: la misma cuenta en el otro origin). */
export interface OnboardingUser {
  account: TestAccount;
  wallet: TestClient;
  recovery: TestClient;
}

export async function newOnboardingUser(env: OnboardingEnv): Promise<OnboardingUser> {
  const account = await createVerifiedUser(env.wallet, env.db);
  const login = async (listener: TestListener) => {
    const client = listener.newClient();
    const response = await client.post('/api/v1/auth/login', { email: account.email, password: account.password });
    if (response.statusCode !== 200) throw new Error(`login falló: ${String(response.statusCode)} ${response.body}`);
    return client;
  };
  return { account, wallet: await login(env.wallet), recovery: await login(env.recovery) };
}

const seenCodes = new Set<string>();

/** El próximo email de step-up de `email` que todavía no se usó (cada código vale una sola vez). */
export async function nextStepUpEmail(email: string): Promise<MailpitMessage> {
  const message = await waitForMessage(
    email,
    (m) => m.subject.includes('Código de verificación') && !seenCodes.has(m.id),
  );
  seenCodes.add(message.id);
  return message;
}

/** Step-up por la API con el código del email (Mailpit); devuelve la PlatformSession atada a una session key nueva. */
export async function stepUp(
  browser: TestClient,
  email: string,
  scope: 'ONBOARDING' | 'ENROLLMENT' | 'KEY_RESTORE' | 'RECOVERY' | 'U_REPLACEMENT',
  keyRestore?: (nonce: Hex) => Promise<{ keyAddress: Address; signature: Hex }>,
  walletId?: string,
): Promise<Session> {
  const key = newSessionKey();
  const started = await browser.post('/api/v1/platform-sessions/step-up/start', {
    scope,
    sessionPublicKey: key.jwk,
    ...(walletId === undefined ? {} : { walletId }),
  });
  if (started.statusCode !== 202) throw new Error(`step-up/start: ${String(started.statusCode)} ${started.body}`);
  const { challengeId, keyRestoreNonce } = started.json<{ challengeId: string; keyRestoreNonce?: Hex }>();
  const message = await nextStepUpEmail(email);
  const body: Record<string, unknown> = { challengeId, code: codeFrom(message) };
  if (scope === 'KEY_RESTORE') {
    if (!keyRestore || !keyRestoreNonce) throw new Error('KEY_RESTORE sin prueba de posesión');
    body.keyRestore = await keyRestore(keyRestoreNonce);
  }
  const finished = await browser.post('/api/v1/platform-sessions/step-up/finish', body);
  if (finished.statusCode !== 200) throw new Error(`step-up/finish: ${String(finished.statusCode)} ${finished.body}`);
  const result = finished.json<{ token: string; session: { id: string; walletId: string | null } }>();
  return { token: result.token, sessionId: result.session.id, key, walletId: result.session.walletId };
}

/** Request crítico firmado con la session key ([B-PSES-05]); con Idempotency-Key si se pide. */
export function critical(
  browser: TestClient,
  session: Session,
  path: string,
  body: unknown = {},
  options: { idempotencyKey?: string; headers?: Record<string, string> } = {},
) {
  const url = `/api/v1${path}`;
  const headers: Record<string, string> = {
    ...signedHeaders({ ...session, method: 'POST', path: url, body: JSON.stringify(body) }),
    ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
    ...options.headers,
  };
  return browser.post(url, body, headers);
}

export const idempotencyKey = () => `idem-${crypto.randomUUID()}`;

export interface UserKeyMaterial {
  account: PrivateKeyAccount;
  authSecretHex: string;
}

export function newUserKey(): UserKeyMaterial {
  return { account: privateKeyToAccount(generatePrivateKey()), authSecretHex: newAuthSecret() };
}

export const KDF_PARAMS = {
  alg: 'argon2id',
  version: 19,
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 4,
  salt: 'xfJ-fQLz5ME95d3FFzXkfg',
} as const;

/** Registro OPAQUE por la API (paso 1 en el servidor, paso 2 en el cliente): devuelve el registrationRecord. */
export async function opaqueRecord(
  browser: TestClient,
  session: Session,
  walletId: string,
  authSecretHex: string,
): Promise<string> {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: authSecretHex });
  const response = await critical(browser, session, `/wallets/${walletId}/user-key/opaque-registration`, {
    registrationRequest,
  });
  if (response.statusCode !== 200)
    throw new Error(`opaque-registration: ${String(response.statusCode)} ${response.body}`);
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: response.json<{ registrationResponse: string }>().registrationResponse,
    password: authSecretHex,
    keyStretching: OPAQUE_KEY_STRETCHING,
  });
  return registrationRecord;
}

export interface RecoveryKeyMaterial {
  account: PrivateKeyAccount;
  enrollmentKey: SessionKey;
}

export function newRecoveryKey(): RecoveryKeyMaterial {
  return { account: privateKeyToAccount(generatePrivateKey()), enrollmentKey: newSessionKey() };
}

/** RecoveryEnrollment firmado por la Enrollment Key ([W-02]) y prueba de control EIP-712 de R ([W-01]). */
export async function enrollmentSubmission(
  env: OnboardingEnv,
  input: {
    userId: string;
    enrollmentId: string;
    nonce: Hex;
    recovery: RecoveryKeyMaterial;
    /** Quién firma la prueba de control (por defecto R). */
    proofSigner?: PrivateKeyAccount;
    issuedAt?: Date;
    expiresAt?: Date;
  },
) {
  const issuedAt = input.issuedAt ?? new Date(Date.now() - 1_000);
  const enrollment = {
    userId: input.userId,
    platformId: env.wallet.config.platformId,
    R: getAddress(input.recovery.account.address),
    nonce: input.nonce,
    issuedAt: issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: (input.expiresAt ?? new Date(issuedAt.getTime() + 10 * 60_000)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const typed = platformTypedData(
    env.wallet.config.chainId,
    env.snapshot.contracts.walletFactory,
    'RecoveryProofOfControl',
    {
      userId: input.userId,
      platformId: env.wallet.config.platformId,
      enrollmentId: input.enrollmentId,
      recoveryKey: enrollment.R,
    },
  );
  const proofOfControl = await (input.proofSigner ?? input.recovery.account).signTypedData(typed);
  return {
    enrollment,
    enrollmentKeySignature: signP256(input.recovery.enrollmentKey, canonicalJson(enrollment)),
    rType: 'INTERNAL' as const,
    proofOfControl,
    storageFlags: { drive: true, file: true, qr: false, words: false },
  };
}

/** Firma de U sobre el typed data de WalletCreationAuthorization que devolvió POST /wallets/{id}/executor. */
export async function signCreationAuthorization(
  user: PrivateKeyAccount,
  typedData: { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> },
): Promise<Hex> {
  const message = { ...typedData.message, saltNonce: BigInt(typedData.message.saltNonce as string) };
  return user.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message,
  } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
}

export interface OnboardedWallet {
  user: OnboardingUser;
  walletId: string;
  userKey: UserKeyMaterial;
  recoveryKey: RecoveryKeyMaterial;
  onboarding: Session;
  enrollmentId: string;
  plan: {
    executor: Address;
    shardId: string;
    expectedSafe: Address;
    saltNonce: string;
    executorAttestation: string;
    typedData: { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> };
  };
}

/** Onboarding por la API hasta `stage` (por defecto hasta la autorización de U; el deploy lo hace cada test). */
export async function onboard(
  env: OnboardingEnv,
  stage: 'user-key' | 'submitted' | 'executor' | 'authorized' = 'authorized',
): Promise<OnboardedWallet> {
  const user = await newOnboardingUser(env);
  const onboarding = await stepUp(user.wallet, user.account.email, 'ONBOARDING');
  const created = await critical(user.wallet, onboarding, '/wallets', {}, { idempotencyKey: idempotencyKey() });
  if (created.statusCode !== 201) throw new Error(`POST /wallets: ${String(created.statusCode)} ${created.body}`);
  const walletId = created.json<{ id: string }>().id;
  const userKey = newUserKey();
  const registrationRecord = await opaqueRecord(user.wallet, onboarding, walletId, userKey.authSecretHex);
  const registered = await critical(
    user.wallet,
    onboarding,
    `/wallets/${walletId}/user-key`,
    {
      userKey: userKey.account.address,
      kdfParams: KDF_PARAMS,
      storageFlags: { drive: true, file: true, qr: false, words: true },
      registrationRecord,
    },
    { idempotencyKey: idempotencyKey() },
  );
  if (registered.statusCode !== 201) throw new Error(`user-key: ${String(registered.statusCode)} ${registered.body}`);
  const recoveryKey = newRecoveryKey();
  const result: OnboardedWallet = {
    user,
    walletId,
    userKey,
    recoveryKey,
    onboarding,
    enrollmentId: '',
    plan: {
      executor: '0x0000000000000000000000000000000000000000',
      shardId: '',
      expectedSafe: '0x0000000000000000000000000000000000000000',
      saltNonce: '0',
      executorAttestation: '',
      typedData: { domain: {}, types: {}, primaryType: '', message: {} },
    },
  };
  if (stage === 'user-key') return result;

  const requested = await critical(
    user.wallet,
    onboarding,
    `/wallets/${walletId}/recovery/enrollments`,
    {},
    {
      idempotencyKey: idempotencyKey(),
    },
  );
  if (requested.statusCode !== 201) throw new Error(`enrollment: ${String(requested.statusCode)} ${requested.body}`);
  const { enrollmentId, nonce } = requested.json<{ enrollmentId: string; nonce: Hex }>();
  result.enrollmentId = enrollmentId;
  const enrollmentSession = await stepUp(user.recovery, user.account.email, 'ENROLLMENT');
  const keyResponse = await critical(
    user.recovery,
    enrollmentSession,
    `/recovery/enrollments/${enrollmentId}/enrollment-key`,
    {
      enrollmentKey: recoveryKey.enrollmentKey.jwk,
    },
  );
  if (keyResponse.statusCode !== 200)
    throw new Error(`enrollment-key: ${String(keyResponse.statusCode)} ${keyResponse.body}`);
  const submission = await enrollmentSubmission(env, {
    userId: user.account.id,
    enrollmentId,
    nonce,
    recovery: recoveryKey,
  });
  const submitted = await critical(
    user.recovery,
    enrollmentSession,
    `/recovery/enrollments/${enrollmentId}/submit`,
    submission,
  );
  if (submitted.statusCode !== 200) throw new Error(`submit: ${String(submitted.statusCode)} ${submitted.body}`);
  if (stage === 'submitted') return result;

  const assigned = await critical(user.wallet, onboarding, `/wallets/${walletId}/executor`, {});
  if (assigned.statusCode !== 200) throw new Error(`executor: ${String(assigned.statusCode)} ${assigned.body}`);
  result.plan = assigned.json<OnboardedWallet['plan']>();
  if (stage === 'executor') return result;

  const authorization = { ...result.plan.typedData.message } as Record<string, unknown>;
  const signature = await signCreationAuthorization(userKey.account, result.plan.typedData);
  const incorporated = await critical(user.wallet, onboarding, `/recovery/enrollments/${enrollmentId}/incorporate`, {
    authorization,
    signature,
  });
  if (incorporated.statusCode !== 200)
    throw new Error(`incorporate: ${String(incorporated.statusCode)} ${incorporated.body}`);
  return result;
}

/** Pide el deploy por la API y corre el deployer (como lo haría el proceso gas-tank con el evento de outbox). */
export async function deploy(env: OnboardingEnv, onboarded: OnboardedWallet): Promise<string> {
  const response = await critical(
    onboarded.user.wallet,
    onboarded.onboarding,
    `/wallets/${onboarded.walletId}/deploy`,
    {},
    {
      idempotencyKey: idempotencyKey(),
    },
  );
  if (response.statusCode !== 202) throw new Error(`deploy: ${String(response.statusCode)} ${response.body}`);
  // Como el job del outbox en el proceso gas-tank (BullMQ lo reintenta con backoff): un error transitorio del RPC
  // del fork o del signer (p. ej. límite de ritmo del RPC remoto, compartido en CI) se reintenta; `handle` retoma
  // desde el estado guardado de la wallet.
  for (let attempt = 1; ; attempt++) {
    try {
      return await env.deployer.handle(onboarded.walletId);
    } catch (error) {
      const transient = (error instanceof SignerClientError && error.retryable) || error instanceof RpcQuorumError;
      if (!transient || attempt >= 5) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 2_000));
    }
  }
}

/** Espera activa hasta que `probe` devuelva un valor definido. */
export async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

/** Borra sólo los contadores de rate limit (`mtw:rl:*`) de la base Valkey del archivo, entre casos del mismo usuario. */
export async function resetRateLimits(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'mtw:rl:*', 'COUNT', 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}
