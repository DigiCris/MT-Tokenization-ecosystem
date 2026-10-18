// Armado de los servicios de cuenta y de onboarding de wallets (los usa el entrypoint `api` y los tests con las mismas
// dependencias reales).
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { AuditWriter } from './audit/audit-writer.ts';
import { AccountService } from './auth/account-service.ts';
import { ChallengeService } from './auth/challenges.ts';
import { PasswordHasher } from './auth/password.ts';
import { LoginRisk } from './auth/risk.ts';
import { SessionService } from './auth/sessions.ts';
import type { RpcQuorumClient } from './chain/rpc-quorum.ts';
import type { AppConfig } from './config/env.ts';
import type { OutboxRepository } from './db/repositories/outbox-repository.ts';
import type { Database } from './db/schema.ts';
import { EmailOutbox } from './email/email-outbox.ts';
import { NotificationService } from './notifications/service.ts';
import type { Logger } from './observability/logger.ts';
import type { Metrics } from './observability/metrics.ts';
import { OpaqueService } from './platform-session/opaque.ts';
import { RequestNonceStore } from './platform-session/request-signature.ts';
import { PlatformSessionService } from './platform-session/sessions.ts';
import { StepUpService } from './platform-session/step-up.ts';
import { PlatformSessionIssuer } from './platform-session/token.ts';
import { WalletUnlockService } from './platform-session/unlock.ts';
import type { BackendPolicySnapshot } from './policy/snapshot.ts';
import { EnrollmentService } from './recovery/enrollment.ts';
import { MigrationService } from './recovery/migration.ts';
import { UReplacementService } from './recovery/u-replacement.ts';
import { RotationService } from './rotations/service.ts';
import type { SignerKeyService } from './signer-client/sharding.ts';
import { OperationService } from './operations/service.ts';
import { OperationStateMachine } from './operations/state-machine.ts';
import { TwoFactorService } from './operations/two-factor.ts';
import { SendService } from './send/service.ts';
import { SwapService } from './swap/prepare.ts';
import { QuoteService } from './swap/quote.ts';
import { BalanceService } from './wallets/balances.ts';
import { TransferService } from './wallets/transfers.ts';
import { WhitelistService } from './whitelist/service.ts';
import { KeyRestoreService } from './wallets/key-restore.ts';
import { SovereignModification } from './wallets/sovereign.ts';
import { WalletService } from './wallets/wallet-service.ts';

/** Lecturas on-chain con quórum y snapshot de policy firmado (direcciones y codehashes del sistema). */
export interface OnchainDeps {
  rpc: RpcQuorumClient;
  snapshot: () => BackendPolicySnapshot;
}

export interface AccountServices {
  sessions: SessionService;
  account: AccountService;
  audit: AuditWriter;
  emails: EmailOutbox;
  /** Challenges de seguridad (OTP/token) compartidos por cuenta, step-up, whitelist y 2FA de alto valor. */
  challenges: ChallengeService;
  issuer: PlatformSessionIssuer;
  opaque: OpaqueService;
  platformSessions: PlatformSessionService;
  stepUp: StepUpService;
  unlock: WalletUnlockService;
  nonces: RequestNonceStore;
  /** KEY_RESTORE (sólo con dependencias on-chain: el step-up verifica la U vigente). */
  keyRestore: KeyRestoreService | null;
  /** Notificaciones in-app de la cuenta (P15.T07). */
  notifications: NotificationService;
}

/** Cuenta [B-AUTH] y PlatformSession [B-PSES] (async: espera el WASM de OPAQUE y valida las claves al arrancar). */
export async function createAccountServices(input: {
  config: AppConfig;
  db: Kysely<Database>;
  redis: Redis;
  outbox: OutboxRepository;
  metrics: Metrics;
  logger: Logger;
  onchain?: OnchainDeps;
}): Promise<AccountServices> {
  const { config, db, redis, outbox, metrics, logger } = input;
  const sessions = new SessionService(db);
  const audit = new AuditWriter(config.secrets.auditChainKey, metrics);
  const emails = new EmailOutbox(outbox, config.secrets.fieldEncryptionKey);
  const challenges = new ChallengeService(config.secrets.otpHmacKey);
  const account = new AccountService({
    db,
    platformId: config.platformId,
    frontendOrigins: { WALLET: config.api.walletOrigin, RECOVERY: config.api.recoveryOrigin },
    hasher: new PasswordHasher(config.secrets.passwordPeppers),
    sessions,
    challenges,
    risk: new LoginRisk(redis, { failureSpikePerMinute: config.auth.failureSpikePerMinute }),
    audit,
    emails,
    fieldKey: config.secrets.fieldEncryptionKey,
    metrics,
    logger: logger.child({ component: 'account' }),
  });
  const issuer = await PlatformSessionIssuer.create(
    config.secrets.sessionIssuerPrivateKey,
    config.secrets.sessionIssuerPublicKey,
  );
  const opaque = await OpaqueService.create({
    db,
    redis,
    serverSetup: config.secrets.opaqueServerSetup,
    platformId: config.platformId,
  });
  const platformSessions = new PlatformSessionService({ db, issuer, platformId: config.platformId });
  const keyRestore = input.onchain
    ? new KeyRestoreService({
        db,
        platformId: config.platformId,
        chainId: config.chainId,
        snapshot: input.onchain.snapshot,
        rpc: input.onchain.rpc,
        opaque,
        audit,
        metrics,
      })
    : null;
  const stepUp = new StepUpService({
    db,
    platformId: config.platformId,
    account,
    challenges,
    platformSessions,
    emails,
    audit,
    metrics,
    ...(keyRestore === null ? {} : { keyRestore }),
  });
  const unlock = new WalletUnlockService({ db, opaque, platformSessions, audit, metrics });
  return {
    sessions,
    account,
    audit,
    emails,
    challenges,
    issuer,
    opaque,
    platformSessions,
    stepUp,
    unlock,
    nonces: new RequestNonceStore(redis),
    keyRestore,
    notifications: new NotificationService({ db }),
  };
}

export interface WalletServices {
  wallets: WalletService;
  enrollments: EnrollmentService;
  keyRestore: KeyRestoreService;
  /** Operaciones de la Safe (P13): prepare interno, firmas, cancelación y lecturas. */
  operations: OperationService;
  /** P14: whitelist, 2FA de alto valor, send, swap y saldos. */
  whitelist: WhitelistService;
  twoFactor: TwoFactorService;
  send: SendService;
  swaps: SwapService;
  balances: BalanceService;
  /** P18.T08: transfers indexados de la Safe (actividad). */
  transfers: TransferService;
  /** P15: rotaciones asistidas (propuesta, ejecución y relay de cancelación) y registro de U' (perdí U). */
  rotations: RotationService;
  uReplacement: UReplacementService;
  /** P15.T06: migración excepcional (casos de operadores y prepare del MIGRATION_TRANSFER). */
  migrations: MigrationService;
}

/** Onboarding de wallets (P12): requiere los servicios de cuenta armados con dependencias on-chain. */
export function createWalletServices(input: {
  config: AppConfig;
  db: Kysely<Database>;
  account: AccountServices;
  onchain: OnchainDeps;
  signerKeys: SignerKeyService;
  outbox: OutboxRepository;
  metrics: Metrics;
  logger: Logger;
}): WalletServices {
  const { config, db, account, onchain, metrics, logger } = input;
  if (account.keyRestore === null) throw new Error('los servicios de cuenta no tienen dependencias on-chain');
  const common = { db, platformId: config.platformId, chainId: config.chainId, snapshot: onchain.snapshot, metrics };
  const operations = new OperationService({
    db,
    machine: new OperationStateMachine({ db, audit: account.audit, outbox: input.outbox }),
    audit: account.audit,
    rpc: onchain.rpc,
    snapshot: onchain.snapshot,
    sovereign: new SovereignModification({
      audit: account.audit,
      email: account.emails,
      logger: logger.child({ component: 'sovereign' }),
      metrics,
    }),
    logger: logger.child({ component: 'operations' }),
    metrics,
  });
  const quotes = new QuoteService({ rpc: onchain.rpc, snapshot: onchain.snapshot, metrics });
  return {
    wallets: new WalletService({
      ...common,
      signerKeys: input.signerKeys,
      opaque: account.opaque,
      rpc: onchain.rpc,
      outbox: input.outbox,
      audit: account.audit,
      logger: logger.child({ component: 'wallets' }),
    }),
    enrollments: new EnrollmentService({
      ...common,
      rpc: onchain.rpc,
      audit: account.audit,
      logger: logger.child({ component: 'recovery-enrollment' }),
    }),
    keyRestore: account.keyRestore,
    operations,
    whitelist: new WhitelistService({
      db,
      operations,
      challenges: account.challenges,
      issuer: account.issuer,
      emails: account.emails,
      audit: account.audit,
      rpc: onchain.rpc,
      snapshot: onchain.snapshot,
      logger: logger.child({ component: 'whitelist' }),
      metrics,
    }),
    twoFactor: new TwoFactorService({
      db,
      challenges: account.challenges,
      issuer: account.issuer,
      emails: account.emails,
      audit: account.audit,
      fieldKey: config.secrets.fieldEncryptionKey,
      snapshot: onchain.snapshot,
      metrics,
    }),
    send: new SendService({ db, operations, snapshot: onchain.snapshot }),
    swaps: new SwapService({ db, operations, quotes, snapshot: onchain.snapshot }),
    balances: new BalanceService({ db, rpc: onchain.rpc, snapshot: onchain.snapshot }),
    transfers: new TransferService({ db, snapshot: onchain.snapshot }),
    rotations: new RotationService({
      db,
      operations,
      signerKeys: input.signerKeys,
      rpc: onchain.rpc,
      snapshot: onchain.snapshot,
      audit: account.audit,
      outbox: input.outbox,
      logger: logger.child({ component: 'rotations' }),
      metrics,
    }),
    uReplacement: new UReplacementService({
      db,
      platformId: config.platformId,
      opaque: account.opaque,
      audit: account.audit,
      emails: account.emails,
      snapshot: onchain.snapshot,
      metrics,
    }),
    migrations: new MigrationService({
      db,
      operations,
      rpc: onchain.rpc,
      snapshot: onchain.snapshot,
      audit: account.audit,
    }),
  };
}
