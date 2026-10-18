// Cuenta centralizada [B-AUTH]: registro y verificación de email, login, sesiones, reset de password, fuerza bruta,
// TOTP y desbloqueo. Las rutas sólo validan y traducen; las reglas viven acá.
//
// Sin enumeración de usuarios: registro, reenvío de verificación, olvido de password y pedido de desbloqueo responden
// igual exista o no la cuenta; el login responde igual (y con un tiempo de hash equivalente) ante un email desconocido
// o una contraseña incorrecta. Los estados de la cuenta (bloqueada, sin verificar, deshabilitada) sólo se revelan a
// quien acierta la contraseña.
import { sql, type Kysely, type Transaction } from 'kysely';
import { ApiError, type ProblemFieldError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Secret } from '../config/secret.ts';
import type { AccountStatus, Client, Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import type { RequestOrigin, TemplateName, TemplateParams } from '../email/templates.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import type { ChallengeService } from './challenges.ts';
import { passwordPolicyProblem, type PasswordHasher, type PasswordProblem } from './password.ts';
import { verifySecondFactor } from './second-factor.ts';
import { THROTTLE, type LoginRisk, type RiskSignal } from './risk.ts';
import type { RevokeReason, SessionService } from './sessions.ts';
import {
  base32Secret,
  generateRecoveryCodes,
  hashRecoveryCode,
  newTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  totpUri,
  verifyTotp,
} from './totp.ts';

export interface RequestMeta {
  client: Client;
  /** IP para los contadores de riesgo (IPv4 completa, IPv6 /64): sólo se usa hasheada, nunca se guarda ni se loguea. */
  ipKey: string | null;
  /** IP truncada (/24, /48) para auditoría, emails y listado de sesiones. */
  ipPrefix: string | null;
  userAgent: string | null;
  requestId: string;
  /** Sesión del request (si había una): se revoca al rotar. */
  currentSessionId: string | null;
}

export interface AccountServiceDeps {
  db: Kysely<Database>;
  platformId: string;
  frontendOrigins: Readonly<Record<Client, string>>;
  hasher: PasswordHasher;
  sessions: SessionService;
  challenges: ChallengeService;
  risk: LoginRisk;
  audit: AuditWriter;
  emails: EmailOutbox;
  fieldKey: Secret<Buffer>;
  metrics: Metrics;
  logger: Logger;
}

export interface UserSummary {
  id: string;
  email: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  locale: string;
  timeZone: string;
  createdAt: Date;
}

export interface NewSession {
  sessionId: string;
  token: string;
  absoluteExpiresAt: Date;
  user: UserSummary;
}

const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  TOO_SHORT: 'debe tener al menos 12 caracteres',
  TOO_LONG: 'debe tener como máximo 128 caracteres',
  COMMON: 'es una contraseña demasiado común',
  CONTAINS_EMAIL: 'no puede contener tu email',
};

const PRODUCT: Record<Client, 'Wallet' | 'Recovery'> = { WALLET: 'Wallet', RECOVERY: 'Recovery' };

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  pepper_version: number;
  status: AccountStatus;
  email_verified_at: Date | null;
  totp_enabled: boolean;
  locale: string;
  time_zone: string;
  created_at: Date;
};

function summary(user: UserRow): UserSummary {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified_at !== null,
    totpEnabled: user.totp_enabled,
    locale: user.locale,
    timeZone: user.time_zone,
    createdAt: user.created_at,
  };
}

function weakPassword(problem: PasswordProblem, path = 'body.password'): ApiError {
  const errors: ProblemFieldError[] = [{ path, message: `la contraseña ${PASSWORD_MESSAGES[problem]}` }];
  return new ApiError('WEAK_PASSWORD', { errors });
}

const USER_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'pepper_version',
  'status',
  'email_verified_at',
  'totp_enabled',
  'locale',
  'time_zone',
  'created_at',
] as const;

export class AccountService {
  readonly #d: AccountServiceDeps;

  constructor(deps: AccountServiceDeps) {
    this.#d = deps;
  }

  /** Transacción SERIALIZABLE que puede auditar (toma el lock de la cadena antes del snapshot). */
  #tx<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return withTransaction(this.#d.db, fn, { auditLock: true });
  }

  #origin(meta: RequestMeta): RequestOrigin {
    return { ipPrefix: meta.ipPrefix, userAgent: meta.userAgent };
  }

  async #email<K extends TemplateName>(
    trx: Transaction<Database>,
    user: { email: string; locale: string; time_zone: string },
    meta: RequestMeta,
    template: K,
    params: TemplateParams[K],
  ): Promise<void> {
    await this.#d.emails.enqueue(trx, {
      to: user.email,
      template,
      params,
      locale: user.locale,
      timeZone: user.time_zone,
      product: PRODUCT[meta.client],
    });
  }

  async #audit(
    trx: Transaction<Database>,
    meta: RequestMeta,
    eventType: string,
    fields: { userId?: string | null; sessionId?: string | null; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.#d.audit.append(trx, {
      actorType: 'USER',
      actorId: fields.userId ?? null,
      userId: fields.userId ?? null,
      sessionId: fields.sessionId ?? null,
      eventType,
      requestId: meta.requestId,
      ipPrefix: meta.ipPrefix,
      payload: { client: meta.client, ...fields.payload },
    });
  }

  async #findUser(db: Kysely<Database>, email: string): Promise<UserRow | undefined> {
    return db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('platform_id', '=', this.#d.platformId)
      .where('email', '=', email)
      .executeTakeFirst();
  }

  /** Revoca la sesión del request (si había) y crea una nueva para el usuario. */
  async #startSession(
    trx: Transaction<Database>,
    user: UserRow,
    meta: RequestMeta,
    reason: RevokeReason,
  ): Promise<NewSession> {
    if (meta.currentSessionId !== null) {
      await trx
        .updateTable('sessions')
        .set({ revoked_at: sql`now()`, revoke_reason: reason })
        .where('id', '=', meta.currentSessionId)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .updateTable('platform_sessions')
        .set({ revoked_at: sql`now()` })
        .where('account_session_id', '=', meta.currentSessionId)
        .where('revoked_at', 'is', null)
        .execute();
    }
    const created = await this.#d.sessions.create(trx, {
      userId: user.id,
      client: meta.client,
      context: { ipPrefix: meta.ipPrefix, userAgent: meta.userAgent },
      rotatedFromId: meta.currentSessionId,
    });
    return { ...created, user: summary(user) };
  }

  // --- Registro y verificación [B-AUTH-01/02] -------------------------------------------------------------

  async register(input: {
    email: string;
    password: string;
    locale?: string | undefined;
    timeZone?: string | undefined;
    meta: RequestMeta;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
    const problem = passwordPolicyProblem(input.password, email);
    if (problem) throw weakPassword(problem);
    const { hash, pepperVersion } = await this.#d.hasher.hash(input.password);
    await this.#tx(async (trx) => {
      const existing = await this.#findUser(trx, email);
      if (existing?.email_verified_at) {
        await this.#email(trx, existing, input.meta, 'registration-attempt', {
          occurredAt: new Date().toISOString(),
          origin: this.#origin(input.meta),
        });
        await this.#audit(trx, input.meta, 'AUTH_REGISTRATION_REQUESTED', {
          userId: existing.id,
          payload: { existing: true },
        });
        return;
      }
      // Preferencias del navegador para los emails (hora local [B-MAIL-02]); sin ellas quedan los defaults.
      const preferences = {
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
      };
      let user = existing;
      if (user) {
        // Cuenta sin verificar: nadie probó todavía ser dueño del email; la última contraseña (y preferencias)
        // registradas quedan vigentes y cualquier sesión previa se cierra.
        user = await trx
          .updateTable('users')
          .set({ password_hash: hash, pepper_version: pepperVersion, ...preferences })
          .where('id', '=', user.id)
          .returning(USER_COLUMNS)
          .executeTakeFirstOrThrow();
        await this.#d.sessions.revokeAll(trx, { userId: user.id, reason: 'PASSWORD_RESET' });
      } else {
        user = await trx
          .insertInto('users')
          .values({
            platform_id: this.#d.platformId,
            email,
            password_hash: hash,
            pepper_version: pepperVersion,
            ...preferences,
          })
          .returning(USER_COLUMNS)
          .executeTakeFirstOrThrow();
      }
      const challenge = await this.#d.challenges.issue(trx, {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        ipPrefix: input.meta.ipPrefix,
      });
      await this.#email(trx, user, input.meta, 'email-verification', {
        code: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
        origin: this.#origin(input.meta),
      });
      await this.#audit(trx, input.meta, 'AUTH_REGISTRATION_REQUESTED', {
        userId: user.id,
        payload: { existing: false },
      });
    });
  }

  async resendVerification(input: { email: string; meta: RequestMeta }): Promise<void> {
    const email = normalizeEmail(input.email);
    await this.#tx(async (trx) => {
      const user = await this.#findUser(trx, email);
      if (!user || user.email_verified_at !== null) return;
      const challenge = await this.#d.challenges.issue(trx, {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        ipPrefix: input.meta.ipPrefix,
      });
      await this.#email(trx, user, input.meta, 'email-verification', {
        code: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
        origin: this.#origin(input.meta),
      });
    });
  }

  /** Verifica el email con el OTP y abre una sesión (probar el control del email equivale a iniciarla). */
  async verifyEmail(input: { email: string; code: string; meta: RequestMeta }): Promise<NewSession> {
    const email = normalizeEmail(input.email);
    const outcome = await this.#tx(async (trx) => {
      const user = await this.#findUser(trx, email);
      // Una cuenta deshabilitada no abre sesión (responde igual que un código incorrecto).
      if (!user || user.status === 'DISABLED') return { error: 'INVALID_CODE' as const };
      const check = await this.#d.challenges.verify(trx, { type: 'EMAIL_VERIFY', userId: user.id, secret: input.code });
      if (check.result !== 'OK') {
        await this.#audit(trx, input.meta, 'AUTH_EMAIL_VERIFICATION_FAILED', {
          userId: user.id,
          payload: { result: check.result },
        });
        return { error: 'INVALID_CODE' as const };
      }
      // El OTP del email es también el factor de desbloqueo [B-AUTH-08]: una cuenta bloqueada queda activa.
      const verified = await trx
        .updateTable('users')
        .set({
          email_verified_at: sql`coalesce(email_verified_at, now())`,
          status: sql<AccountStatus>`CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END`,
          failed_login_count: 0,
          last_failed_login_at: null,
        })
        .where('id', '=', user.id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const session = await this.#startSession(trx, verified, input.meta, 'ROTATED');
      await this.#audit(trx, input.meta, 'AUTH_EMAIL_VERIFIED', { userId: user.id, sessionId: session.sessionId });
      await this.#audit(trx, input.meta, 'AUTH_LOGIN_SUCCEEDED', {
        userId: user.id,
        sessionId: session.sessionId,
        payload: { method: 'EMAIL_OTP' },
      });
      return { session };
    });
    if ('error' in outcome) throw new ApiError(outcome.error);
    await this.#d.risk.clearAccount(this.#d.platformId, email);
    return outcome.session;
  }

  // --- Login y fuerza bruta [B-AUTH-03/08] ---------------------------------------------------------------

  /**
   * Fallo de contraseña o de segundo factor (login o re-autenticación): contadores de cuenta e IP, bloqueo blando al
   * 10.º fallo de la cuenta, señales de riesgo y auditoría.
   */
  async #recordFailure(
    user: UserRow | undefined,
    email: string,
    meta: RequestMeta,
    reason: string,
    eventType: 'AUTH_LOGIN_FAILED' | 'TOTP_DISABLE_FAILED' | 'STEP_UP_FAILED' = 'AUTH_LOGIN_FAILED',
  ): Promise<void> {
    const outcome = await this.#d.risk.recordFailure(this.#d.platformId, email, meta.ipKey);
    const failures = outcome.accountFailures;
    this.#d.metrics.authFailures.inc({ reason });
    for (const signal of outcome.signals) this.#riskSignal(signal, meta);
    await this.#tx(async (trx) => {
      for (const signal of outcome.signals) {
        await this.#audit(trx, meta, 'AUTH_RISK_SIGNAL', { payload: { signal, ipFailures: outcome.ipFailures } });
      }
      if (user) {
        await trx
          .updateTable('users')
          .set({ failed_login_count: sql`failed_login_count + 1`, last_failed_login_at: sql`now()` })
          .where('id', '=', user.id)
          .execute();
        if (failures >= THROTTLE.softLockFailures && user.status === 'ACTIVE') {
          await trx
            .updateTable('users')
            .set({ status: 'LOCKED' })
            .where('id', '=', user.id)
            .where('status', '=', 'ACTIVE')
            .execute();
          const challenge = await this.#d.challenges.issue(trx, {
            userId: user.id,
            type: 'LOGIN_UNLOCK',
            ipPrefix: meta.ipPrefix,
          });
          await this.#email(trx, user, meta, 'login-unlock', {
            code: challenge.secret,
            expiresAt: challenge.expiresAt.toISOString(),
            origin: this.#origin(meta),
          });
          await this.#audit(trx, meta, 'AUTH_ACCOUNT_LOCKED', { userId: user.id, payload: { failures } });
        }
      }
      await this.#audit(trx, meta, eventType, {
        userId: user?.id ?? null,
        payload: { reason, email, failures },
      });
    });
  }

  /** Señal de credential stuffing [B-AUTH-08]: métrica (alerta en P24) y log de advertencia. */
  #riskSignal(signal: RiskSignal, meta: RequestMeta): void {
    this.#d.metrics.authRiskSignals.inc({ signal });
    this.#d.logger.warn(
      { signal, client: meta.client, ipPrefix: meta.ipPrefix, requestId: meta.requestId },
      'señal de riesgo de autenticación',
    );
  }

  async login(input: {
    email: string;
    password: string;
    totp?: string | undefined;
    recoveryCode?: string | undefined;
    meta: RequestMeta;
  }): Promise<NewSession> {
    const email = normalizeEmail(input.email);
    const wait = await this.#d.risk.retryAfter(this.#d.platformId, email, input.meta.ipKey);
    if (wait > 0) throw new ApiError('RATE_LIMITED', { headers: { 'retry-after': String(wait) } });

    const user = await this.#findUser(this.#d.db, email);
    if (!user) {
      await this.#d.hasher.burn(input.password);
      await this.#recordFailure(undefined, email, input.meta, 'invalid_credentials');
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if (!(await this.#d.hasher.verify(user.password_hash, user.pepper_version, input.password))) {
      await this.#recordFailure(user, email, input.meta, 'invalid_credentials');
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if (user.status === 'DISABLED') throw new ApiError('ACCOUNT_DISABLED');
    if (user.status === 'LOCKED') {
      await this.requestUnlock({ email, meta: input.meta });
      throw new ApiError('ACCOUNT_LOCKED');
    }
    if (user.email_verified_at === null) {
      await this.resendVerification({ email, meta: input.meta });
      throw new ApiError('EMAIL_NOT_VERIFIED');
    }
    if (user.totp_enabled && input.totp === undefined && input.recoveryCode === undefined) {
      throw new ApiError('TOTP_REQUIRED');
    }
    const rehash = this.#d.hasher.needsRehash(user.pepper_version) ? await this.#d.hasher.hash(input.password) : null;

    const outcome = await this.#tx(async (trx) => {
      if (user.totp_enabled && !(await verifySecondFactor(trx, this.#d.fieldKey, user.id, input))) {
        return { error: 'INVALID_TOTP' as const };
      }
      const updated = await trx
        .updateTable('users')
        .set({
          failed_login_count: 0,
          last_failed_login_at: null,
          ...(rehash ? { password_hash: rehash.hash, pepper_version: rehash.pepperVersion } : {}),
        })
        .where('id', '=', user.id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const session = await this.#startSession(trx, updated, input.meta, 'ROTATED');
      await this.#audit(trx, input.meta, 'AUTH_LOGIN_SUCCEEDED', {
        userId: user.id,
        sessionId: session.sessionId,
        payload: {
          method: user.totp_enabled
            ? input.totp !== undefined
              ? 'PASSWORD_TOTP'
              : 'PASSWORD_RECOVERY_CODE'
            : 'PASSWORD',
        },
      });
      const occurredAt = new Date().toISOString();
      await this.#email(trx, updated, input.meta, 'new-login', { occurredAt, origin: this.#origin(input.meta) });
      // [B-MAIL-03]: también en la bandeja in-app (sin datos de la sesión más allá del origen truncado).
      await notify(
        trx,
        {
          userId: user.id,
          walletId: null,
          type: 'NEW_LOGIN',
          payload: { app: input.meta.client, occurredAt, ipPrefix: input.meta.ipPrefix },
        },
        this.#d.metrics,
      );
      return { session };
    });
    if ('error' in outcome) {
      await this.#recordFailure(user, email, input.meta, 'invalid_totp');
      throw new ApiError('INVALID_TOTP');
    }
    await this.#d.risk.clearAccount(this.#d.platformId, email);
    return outcome.session;
  }

  async logout(session: { sessionId: string; userId: string }, meta: RequestMeta): Promise<void> {
    await this.#tx(async (trx) => {
      await this.#d.sessions.revoke(trx, { userId: session.userId, sessionId: session.sessionId, reason: 'LOGOUT' });
      await this.#audit(trx, meta, 'AUTH_LOGOUT', { userId: session.userId, sessionId: session.sessionId });
    });
  }

  // --- Desbloqueo [B-AUTH-08] --------------------------------------------------------------------------------

  async requestUnlock(input: { email: string; meta: RequestMeta }): Promise<void> {
    const email = normalizeEmail(input.email);
    await this.#tx(async (trx) => {
      const user = await this.#findUser(trx, email);
      if (user?.status !== 'LOCKED') return;
      const open = await trx
        .selectFrom('security_challenges')
        .select('id')
        .where('user_id', '=', user.id)
        .where('type', '=', 'LOGIN_UNLOCK')
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .where('created_at', '>', sql<Date>`now() - interval '2 minutes'`)
        .executeTakeFirst();
      if (open) return;
      const challenge = await this.#d.challenges.issue(trx, {
        userId: user.id,
        type: 'LOGIN_UNLOCK',
        ipPrefix: input.meta.ipPrefix,
      });
      await this.#email(trx, user, input.meta, 'login-unlock', {
        code: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
        origin: this.#origin(input.meta),
      });
    });
  }

  async unlock(input: { email: string; code: string; meta: RequestMeta }): Promise<void> {
    const email = normalizeEmail(input.email);
    const outcome = await this.#tx(async (trx) => {
      const user = await this.#findUser(trx, email);
      if (user?.status !== 'LOCKED') return { error: 'INVALID_CODE' as const };
      const check = await this.#d.challenges.verify(trx, { type: 'LOGIN_UNLOCK', userId: user.id, secret: input.code });
      if (check.result !== 'OK') return { error: 'INVALID_CODE' as const };
      await trx
        .updateTable('users')
        .set({ status: 'ACTIVE', failed_login_count: 0, last_failed_login_at: null })
        .where('id', '=', user.id)
        .execute();
      await this.#audit(trx, input.meta, 'AUTH_ACCOUNT_UNLOCKED', { userId: user.id });
      return { ok: true as const };
    });
    if ('error' in outcome) throw new ApiError(outcome.error);
    await this.#d.risk.clearAccount(this.#d.platformId, email);
  }

  // --- Olvido y reset de password [B-AUTH-07] ------------------------------------------------------------

  async requestPasswordReset(input: { email: string; meta: RequestMeta }): Promise<void> {
    const email = normalizeEmail(input.email);
    await this.#tx(async (trx) => {
      const user = await this.#findUser(trx, email);
      if (!user || user.status === 'DISABLED') return;
      const challenge = await this.#d.challenges.issue(trx, {
        userId: user.id,
        type: 'PASSWORD_RESET',
        ipPrefix: input.meta.ipPrefix,
      });
      // El token va en el fragmento: no queda en logs de servidores ni en el header Referer.
      const resetUrl = `${this.#d.frontendOrigins[input.meta.client]}/reset-password#token=${challenge.challengeId}.${challenge.secret}`;
      await this.#email(trx, user, input.meta, 'password-reset', {
        resetUrl,
        expiresAt: challenge.expiresAt.toISOString(),
        origin: this.#origin(input.meta),
      });
      await this.#audit(trx, input.meta, 'AUTH_PASSWORD_RESET_REQUESTED', { userId: user.id });
    });
  }

  /** Reset con el token del email: revoca todas las sesiones y PlatformSessions; no toca U, R, OPAQUE ni claves. */
  async resetPassword(input: { token: string; newPassword: string; meta: RequestMeta }): Promise<void> {
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(input.token);
    if (!match?.[1] || !match[2]) throw new ApiError('INVALID_TOKEN');
    const [challengeId, secret] = [match[1], match[2]];
    const owner = await this.#d.db
      .selectFrom('security_challenges as c')
      .innerJoin('users as u', 'u.id', 'c.user_id')
      .select(['u.email'])
      .where('c.id', '=', challengeId)
      .where('c.type', '=', 'PASSWORD_RESET')
      .executeTakeFirst();
    if (!owner) throw new ApiError('INVALID_TOKEN');
    const problem = passwordPolicyProblem(input.newPassword, owner.email);
    if (problem) throw weakPassword(problem, 'body.newPassword');
    const { hash, pepperVersion } = await this.#d.hasher.hash(input.newPassword);

    const outcome = await this.#tx(async (trx) => {
      const check = await this.#d.challenges.verify(trx, { type: 'PASSWORD_RESET', challengeId, secret });
      if (check.result !== 'OK' || check.userId === undefined) return { error: 'INVALID_TOKEN' as const };
      const user = await trx
        .updateTable('users')
        .set({
          password_hash: hash,
          pepper_version: pepperVersion,
          status: sql<AccountStatus>`CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END`,
          failed_login_count: 0,
          last_failed_login_at: null,
          // Abrir el enlace del email prueba el control de la casilla.
          email_verified_at: sql`coalesce(email_verified_at, now())`,
        })
        .where('id', '=', check.userId)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const revoked = await this.#d.sessions.revokeAll(trx, { userId: user.id, reason: 'PASSWORD_RESET' });
      await this.#d.challenges.invalidate(trx, user.id, 'PASSWORD_RESET');
      await this.#audit(trx, input.meta, 'AUTH_PASSWORD_RESET_COMPLETED', {
        userId: user.id,
        payload: { revokedSessions: revoked },
      });
      const occurredAt = new Date().toISOString();
      await this.#email(trx, user, input.meta, 'password-reset-completed', {
        occurredAt,
        origin: this.#origin(input.meta),
      });
      await notify(
        trx,
        {
          userId: user.id,
          walletId: null,
          type: 'PASSWORD_RESET_COMPLETED',
          payload: { app: input.meta.client, occurredAt, revokedSessions: revoked, ipPrefix: input.meta.ipPrefix },
        },
        this.#d.metrics,
      );
      return { email: user.email };
    });
    if ('error' in outcome) throw new ApiError(outcome.error);
    await this.#d.risk.clearAccount(this.#d.platformId, outcome.email);
  }

  // --- TOTP [B-AUTH-09] -------------------------------------------------------------------------------------

  async totpSetup(session: { userId: string }): Promise<{ otpauthUri: string; secret: string }> {
    return this.#tx(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['email', 'totp_enabled'])
        .where('id', '=', session.userId)
        .executeTakeFirstOrThrow();
      if (user.totp_enabled) throw new ApiError('CONFLICT', { detail: 'la verificación en dos pasos ya está activa' });
      const secret = newTotpSecret();
      const sealed = sealTotpSecret(this.#d.fieldKey, session.userId, secret);
      await trx
        .insertInto('totp_factors')
        .values({ user_id: session.userId, secret_ciphertext: sealed })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            secret_ciphertext: sealed,
            last_used_step: null,
            recovery_code_hashes: sql`'{}'::text[]`,
            enabled_at: null,
          }),
        )
        .execute();
      return { otpauthUri: totpUri(secret, user.email), secret: base32Secret(secret) };
    });
  }

  async totpEnable(
    session: { userId: string; sessionId: string },
    code: string,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[]; session: NewSession }> {
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c)));
    const outcome = await this.#tx(async (trx) => {
      const factor = await trx
        .selectFrom('totp_factors')
        .select(['secret_ciphertext', 'enabled_at'])
        .where('user_id', '=', session.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!factor) return { error: 'CONFLICT' as const };
      if (factor.enabled_at !== null) return { error: 'CONFLICT' as const };
      const check = verifyTotp(openTotpSecret(this.#d.fieldKey, session.userId, factor.secret_ciphertext), code, null);
      if (!check.ok) return { error: 'INVALID_CODE' as const };
      await trx
        .updateTable('totp_factors')
        .set({
          enabled_at: sql`now()`,
          last_used_step: check.step.toString(),
          recovery_code_hashes: sql`${hashes}::text[]`,
        })
        .where('user_id', '=', session.userId)
        .execute();
      const user = await trx
        .updateTable('users')
        .set({ totp_enabled: true })
        .where('id', '=', session.userId)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const next = await this.#startSession(
        trx,
        user,
        { ...meta, currentSessionId: session.sessionId },
        'TOTP_CHANGED',
      );
      await this.#audit(trx, meta, 'TOTP_ENABLED', { userId: user.id, sessionId: next.sessionId });
      await this.#email(trx, user, meta, 'totp-enabled', {
        occurredAt: new Date().toISOString(),
        origin: this.#origin(meta),
      });
      return { session: next };
    });
    if ('error' in outcome) {
      // Código incorrecto con sesión vigente: 400 (un 401 haría que el frontend cierre la sesión).
      throw outcome.error === 'CONFLICT'
        ? new ApiError('CONFLICT', { detail: 'no hay una configuración de TOTP pendiente' })
        : new ApiError('INVALID_CODE');
    }
    return { recoveryCodes: codes, session: outcome.session };
  }

  async totpDisable(
    session: { userId: string; sessionId: string },
    input: { password: string; totp?: string | undefined; recoveryCode?: string | undefined },
    meta: RequestMeta,
  ): Promise<NewSession> {
    const user = await this.#d.db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('id', '=', session.userId)
      .executeTakeFirstOrThrow();
    if (!user.totp_enabled) throw new ApiError('CONFLICT', { detail: 'la verificación en dos pasos no está activa' });
    // Re-autenticación: los fallos cuentan en el mismo presupuesto de fuerza bruta que el login (una sesión robada no
    // permite adivinar la contraseña). 403 y no 401: la sesión sigue vigente.
    const wait = await this.#d.risk.retryAfter(this.#d.platformId, user.email, meta.ipKey);
    if (wait > 0) throw new ApiError('RATE_LIMITED', { headers: { 'retry-after': String(wait) } });
    if (!(await this.#d.hasher.verify(user.password_hash, user.pepper_version, input.password))) {
      await this.#recordFailure(user, user.email, meta, 'totp_disable_password', 'TOTP_DISABLE_FAILED');
      throw new ApiError('REAUTH_FAILED');
    }
    const outcome = await this.#tx(async (trx) => {
      if (!(await verifySecondFactor(trx, this.#d.fieldKey, user.id, input)))
        return { error: 'REAUTH_FAILED' as const };
      await trx.deleteFrom('totp_factors').where('user_id', '=', user.id).execute();
      const updated = await trx
        .updateTable('users')
        .set({ totp_enabled: false })
        .where('id', '=', user.id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      const next = await this.#startSession(
        trx,
        updated,
        { ...meta, currentSessionId: session.sessionId },
        'TOTP_CHANGED',
      );
      await this.#audit(trx, meta, 'TOTP_DISABLED', { userId: user.id, sessionId: next.sessionId });
      await this.#email(trx, updated, meta, 'totp-disabled', {
        occurredAt: new Date().toISOString(),
        origin: this.#origin(meta),
      });
      return { session: next };
    });
    if ('error' in outcome) {
      await this.#recordFailure(user, user.email, meta, 'totp_disable_code', 'TOTP_DISABLE_FAILED');
      throw new ApiError('REAUTH_FAILED');
    }
    return outcome.session;
  }

  // --- Re-autenticación (step-up de PlatformSession) ------------------------------------------------------------

  /** Segundos de espera de fuerza bruta de la cuenta para esa IP (0 si puede intentar). */
  async reauthRetryAfter(userId: string, meta: RequestMeta): Promise<number> {
    const user = await this.#d.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    return this.#d.risk.retryAfter(this.#d.platformId, user.email, meta.ipKey);
  }

  /** Un segundo factor incorrecto fuera del login cuenta en el mismo presupuesto de fuerza bruta de la cuenta. */
  async recordReauthFailure(userId: string, meta: RequestMeta, reason: string): Promise<void> {
    const user = await this.#d.db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    await this.#recordFailure(user, user.email, meta, reason, 'STEP_UP_FAILED');
  }

  /** Verifica el segundo factor del usuario dentro de la transacción del llamador (consume el código). */
  verifySecondFactor(
    trx: Transaction<Database>,
    userId: string,
    input: { totp?: string | undefined; recoveryCode?: string | undefined },
  ): Promise<boolean> {
    return verifySecondFactor(trx, this.#d.fieldKey, userId, input);
  }

  /** Rota la sesión de cuenta del request ([B-AUTH-04]: login, step-up, cambios de privilegio). */
  async rotateSession(
    trx: Transaction<Database>,
    userId: string,
    meta: RequestMeta,
    reason: RevokeReason,
  ): Promise<NewSession> {
    const user = await trx.selectFrom('users').select(USER_COLUMNS).where('id', '=', userId).executeTakeFirstOrThrow();
    return this.#startSession(trx, user, meta, reason);
  }

  // --- Sesiones y perfil -----------------------------------------------------------------------------------

  async listSessions(session: { userId: string; sessionId: string }) {
    const rows = await this.#d.sessions.list(session.userId);
    return rows.map((r) => ({
      id: r.id,
      client: r.client,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.absolute_expires_at,
      ipPrefix: r.ip_prefix,
      userAgent: r.user_agent,
      current: r.id === session.sessionId,
    }));
  }

  /** Revoca una sesión propia (404 si no existe o es de otro usuario, [B-AUTHZ]). */
  async revokeSession(
    session: { userId: string; sessionId: string },
    targetId: string,
    meta: RequestMeta,
  ): Promise<{ current: boolean }> {
    const revoked = await this.#tx(async (trx) => {
      const ok = await this.#d.sessions.revoke(trx, {
        userId: session.userId,
        sessionId: targetId,
        reason: 'USER_REVOKED',
      });
      if (ok) {
        await this.#audit(trx, meta, 'SESSION_REVOKED', {
          userId: session.userId,
          sessionId: session.sessionId,
          payload: { revokedSessionId: targetId },
        });
      }
      return ok;
    });
    if (!revoked) throw new ApiError('NOT_FOUND');
    return { current: targetId === session.sessionId };
  }

  async revokeOtherSessions(session: { userId: string; sessionId: string }, meta: RequestMeta): Promise<number> {
    return this.#tx(async (trx) => {
      const count = await this.#d.sessions.revokeAll(trx, {
        userId: session.userId,
        reason: 'ALL_OTHERS_REVOKED',
        exceptSessionId: session.sessionId,
      });
      await this.#audit(trx, meta, 'SESSION_REVOKED', {
        userId: session.userId,
        sessionId: session.sessionId,
        payload: { allOthers: true, count },
      });
      return count;
    });
  }

  async me(userId: string): Promise<UserSummary> {
    return summary(
      await this.#d.db.selectFrom('users').select(USER_COLUMNS).where('id', '=', userId).executeTakeFirstOrThrow(),
    );
  }

  async updateMe(
    userId: string,
    patch: { locale?: string | undefined; timeZone?: string | undefined },
  ): Promise<UserSummary> {
    const updated = await this.#d.db
      .updateTable('users')
      .set({
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        ...(patch.timeZone === undefined ? {} : { time_zone: patch.timeZone }),
      })
      .where('id', '=', userId)
      .returning(USER_COLUMNS)
      .executeTakeFirstOrThrow();
    return summary(updated);
  }
}
