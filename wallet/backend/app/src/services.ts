// Armado de los servicios de cuenta (los usa el entrypoint `api` y los tests con las mismas dependencias reales).
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { AuditWriter } from './audit/audit-writer.ts';
import { AccountService } from './auth/account-service.ts';
import { ChallengeService } from './auth/challenges.ts';
import { PasswordHasher } from './auth/password.ts';
import { LoginRisk } from './auth/risk.ts';
import { SessionService } from './auth/sessions.ts';
import type { AppConfig } from './config/env.ts';
import type { OutboxRepository } from './db/repositories/outbox-repository.ts';
import type { Database } from './db/schema.ts';
import { EmailOutbox } from './email/email-outbox.ts';
import type { Logger } from './observability/logger.ts';
import type { Metrics } from './observability/metrics.ts';
import { OpaqueService } from './platform-session/opaque.ts';
import { RequestNonceStore } from './platform-session/request-signature.ts';
import { PlatformSessionService } from './platform-session/sessions.ts';
import { StepUpService } from './platform-session/step-up.ts';
import { PlatformSessionIssuer } from './platform-session/token.ts';
import { WalletUnlockService } from './platform-session/unlock.ts';

export interface AccountServices {
  sessions: SessionService;
  account: AccountService;
  audit: AuditWriter;
  emails: EmailOutbox;
  issuer: PlatformSessionIssuer;
  opaque: OpaqueService;
  platformSessions: PlatformSessionService;
  stepUp: StepUpService;
  unlock: WalletUnlockService;
  nonces: RequestNonceStore;
}

/** Cuenta [B-AUTH] y PlatformSession [B-PSES] (async: espera el WASM de OPAQUE y valida las claves al arrancar). */
export async function createAccountServices(input: {
  config: AppConfig;
  db: Kysely<Database>;
  redis: Redis;
  outbox: OutboxRepository;
  metrics: Metrics;
  logger: Logger;
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
  const stepUp = new StepUpService({
    db,
    platformId: config.platformId,
    account,
    challenges,
    platformSessions,
    emails,
    audit,
    metrics,
  });
  const unlock = new WalletUnlockService({ db, opaque, platformSessions, audit, metrics });
  return {
    sessions,
    account,
    audit,
    emails,
    issuer,
    opaque,
    platformSessions,
    stepUp,
    unlock,
    nonces: new RequestNonceStore(redis),
  };
}
