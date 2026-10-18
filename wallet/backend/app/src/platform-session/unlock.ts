// Desbloqueo de la Wallet [B-PSES-01/02]: login OPAQUE con AuthSecret_U → PlatformSession OPERATIONS (15 min) atada a
// la session key del cliente y a la sesión de cuenta del request. Cada paso queda auditado; los fallos responden igual
// (403 REAUTH_FAILED) sin decir si falló el intento, el mensaje final o el binding.
import type { Kysely } from 'kysely';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { RequestMeta } from '../auth/account-service.ts';
import type { AuthenticatedSession } from '../auth/sessions.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { P256PublicJwk } from './keys.ts';
import { OpaqueAuthError, OpaqueProtocolError, WalletNotActiveError, type OpaqueService } from './opaque.ts';
import type { IssuedPlatformSession, PlatformSessionService } from './sessions.ts';

export class WalletUnlockService {
  readonly #db: Kysely<Database>;
  readonly #opaque: OpaqueService;
  readonly #sessions: PlatformSessionService;
  readonly #audit: AuditWriter;
  readonly #metrics: Metrics;

  constructor(deps: {
    db: Kysely<Database>;
    opaque: OpaqueService;
    platformSessions: PlatformSessionService;
    audit: AuditWriter;
    metrics: Metrics;
  }) {
    this.#db = deps.db;
    this.#opaque = deps.opaque;
    this.#sessions = deps.platformSessions;
    this.#audit = deps.audit;
    this.#metrics = deps.metrics;
  }

  async start(input: {
    session: AuthenticatedSession;
    startLoginRequest: string;
    sessionPublicKey: P256PublicJwk;
    walletId?: string | undefined;
  }) {
    try {
      return await this.#opaque.loginStart({
        userId: input.session.userId,
        accountSessionId: input.session.sessionId,
        startLoginRequest: input.startLoginRequest,
        sessionPublicKey: input.sessionPublicKey,
        ...(input.walletId === undefined ? {} : { walletId: input.walletId }),
      });
    } catch (error) {
      if (error instanceof WalletNotActiveError) throw new ApiError('WALLET_NOT_ACTIVE');
      if (error instanceof OpaqueProtocolError)
        throw new ApiError('BAD_REQUEST', { detail: 'mensaje OPAQUE inválido' });
      throw error;
    }
  }

  async finish(input: {
    session: AuthenticatedSession;
    loginAttemptId: string;
    finishLoginRequest: string;
    sessionKeyBinding: string;
    meta: RequestMeta;
  }): Promise<IssuedPlatformSession> {
    const { session, meta } = input;
    try {
      const result = await this.#opaque.loginFinish({
        userId: session.userId,
        accountSessionId: session.sessionId,
        loginAttemptId: input.loginAttemptId,
        finishLoginRequest: input.finishLoginRequest,
        sessionKeyBinding: input.sessionKeyBinding,
      });
      return await withTransaction(
        this.#db,
        async (trx) => {
          const issued = await this.#sessions.issue(trx, {
            userId: session.userId,
            accountSessionId: session.sessionId,
            walletId: result.walletId,
            safe: result.safe,
            scope: 'OPERATIONS',
            authMethod: 'OPAQUE_U',
            sessionPublicKey: result.sessionPublicKey,
          });
          await this.#audit.append(trx, {
            actorType: 'USER',
            actorId: session.userId,
            userId: session.userId,
            walletId: result.walletId,
            sessionId: session.sessionId,
            eventType: 'PLATFORM_SESSION_ISSUED',
            requestId: meta.requestId,
            ipPrefix: meta.ipPrefix,
            payload: {
              client: meta.client,
              platformSessionId: issued.claims.sessionId,
              scope: 'OPERATIONS',
              authMethod: 'OPAQUE_U',
              keyVersion: result.keyVersion,
            },
          });
          return issued;
        },
        { auditLock: true },
      );
    } catch (error) {
      if (!(error instanceof OpaqueAuthError)) throw error;
      this.#metrics.authFailures.inc({ reason: 'opaque_login' });
      await withTransaction(
        this.#db,
        (trx) =>
          this.#audit.append(trx, {
            actorType: 'USER',
            actorId: session.userId,
            userId: session.userId,
            sessionId: session.sessionId,
            eventType: 'OPAQUE_LOGIN_FAILED',
            requestId: meta.requestId,
            ipPrefix: meta.ipPrefix,
            payload: { client: meta.client, reason: error.reason, loginAttemptId: input.loginAttemptId },
          }),
        { auditLock: true },
      );
      throw new ApiError('REAUTH_FAILED');
    }
  }
}
