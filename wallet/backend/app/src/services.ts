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

export interface AccountServices {
  sessions: SessionService;
  account: AccountService;
  audit: AuditWriter;
  emails: EmailOutbox;
}

export function createAccountServices(input: {
  config: AppConfig;
  db: Kysely<Database>;
  redis: Redis;
  outbox: OutboxRepository;
  metrics: Metrics;
  logger: Logger;
}): AccountServices {
  const { config, db, redis, outbox, metrics, logger } = input;
  const sessions = new SessionService(db);
  const audit = new AuditWriter(config.secrets.auditChainKey, metrics);
  const emails = new EmailOutbox(outbox, config.secrets.fieldEncryptionKey);
  const account = new AccountService({
    db,
    platformId: config.platformId,
    frontendOrigins: { WALLET: config.api.walletOrigin, RECOVERY: config.api.recoveryOrigin },
    hasher: new PasswordHasher(config.secrets.passwordPeppers),
    sessions,
    challenges: new ChallengeService(config.secrets.otpHmacKey),
    risk: new LoginRisk(redis, { failureSpikePerMinute: config.auth.failureSpikePerMinute }),
    audit,
    emails,
    fieldKey: config.secrets.fieldEncryptionKey,
    metrics,
    logger: logger.child({ component: 'account' }),
  });
  return { sessions, account, audit, emails };
}
