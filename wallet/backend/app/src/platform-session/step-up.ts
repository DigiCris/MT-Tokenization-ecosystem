// Step-up de PlatformSession [B-PSES-03]: sin U, la cuenta autenticada prueba el control del email con un OTP (y el
// TOTP si está activo) y obtiene una PlatformSession de scope restringido, atada a la session key que el cliente
// presentó al pedirlo. Nunca otorga OPERATIONS; ONBOARDING deja de emitirse cuando la wallet está ACTIVE.
//
// - Cada scope corresponde a una app ([W-07]): ONBOARDING y U_REPLACEMENT en Wallet; RECOVERY y ENROLLMENT en Recovery.
// - El step-up rota la sesión de cuenta ([B-AUTH-04]) y la PlatformSession queda atada a la sesión nueva.
// - KEY_RESTORE exige además la prueba de posesión de U: firma EIP-712 KeyRestore sobre el nonce del challenge de la
//   U vigente on-chain (wallets/key-restore.ts), verificada antes de consumir el código.
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { AccountService, NewSession, RequestMeta } from '../auth/account-service.ts';
import type { ChallengeService } from '../auth/challenges.ts';
import type { AuthenticatedSession } from '../auth/sessions.ts';
import type { Client, Database, WalletStatus } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import type { Metrics } from '../observability/metrics.ts';
import { jwkThumbprint, P256PublicJwkSchema, type P256PublicJwk } from './keys.ts';
import { safeAddressOf, type IssuedPlatformSession, type PlatformSessionService } from './sessions.ts';

export const STEP_UP_SCOPES = ['ONBOARDING', 'RECOVERY', 'U_REPLACEMENT', 'ENROLLMENT', 'KEY_RESTORE'] as const;
export type StepUpScope = (typeof STEP_UP_SCOPES)[number];

/** App ([W-07]) y listener de cada scope. */
export const STEP_UP_LISTENER: Readonly<Record<StepUpScope, Client>> = {
  ONBOARDING: 'WALLET',
  U_REPLACEMENT: 'WALLET',
  KEY_RESTORE: 'WALLET',
  RECOVERY: 'RECOVERY',
  ENROLLMENT: 'RECOVERY',
};

/** Qué dice el email del código ([B-MAIL-02]: acción). */
const PURPOSE: Readonly<Record<StepUpScope, string>> = {
  ONBOARDING: 'crear y activar tu wallet',
  U_REPLACEMENT: 'reemplazar tu clave de usuario (U)',
  RECOVERY: 'operar con tu clave de recuperación (R)',
  ENROLLMENT: 'vincular una clave de recuperación (R)',
  KEY_RESTORE: 'restaurar tu clave de usuario (U) en este dispositivo',
};

/** Política de [B-RL] de cada scope. */
export const STEP_UP_RATE_POLICY = {
  ONBOARDING: 'step-up-onboarding',
  ENROLLMENT: 'step-up-onboarding',
  RECOVERY: 'recovery-sensitive',
  U_REPLACEMENT: 'recovery-sensitive',
  KEY_RESTORE: 'recovery-sensitive',
} as const satisfies Record<StepUpScope, string>;

const LIVE_WALLET_EXCLUDED: readonly WalletStatus[] = ['FAILED', 'ABANDONED', 'MIGRATED'];

const BindingSchema = z.object({
  scope: z.enum(STEP_UP_SCOPES),
  accountSessionId: z.uuid(),
  walletId: z.uuid().nullable(),
  sessionPublicKey: P256PublicJwkSchema,
  sessionKeyThumbprint: z.string(),
  /** KEY_RESTORE: nonce que firma la U restaurada (KeyRestore.nonce). */
  keyRestoreNonce: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
});

/** Verificador de la prueba de posesión de KEY_RESTORE (wallets/key-restore.ts). */
export interface KeyRestoreVerifier {
  verifyProof(input: {
    userId: string;
    walletId: string;
    keyAddress: Address;
    nonce: Hex;
    signature: Hex;
  }): Promise<void>;
}

interface LiveWallet {
  id: string;
  status: WalletStatus;
  safe: Address | null;
}

export interface StepUpServiceDeps {
  db: Kysely<Database>;
  platformId: string;
  account: AccountService;
  challenges: ChallengeService;
  platformSessions: PlatformSessionService;
  emails: EmailOutbox;
  audit: AuditWriter;
  metrics: Metrics;
  /** Sin verificador (procesos sin RPC ni snapshot) el scope KEY_RESTORE no se emite. */
  keyRestore?: KeyRestoreVerifier;
}

export class StepUpService {
  readonly #d: StepUpServiceDeps;

  constructor(deps: StepUpServiceDeps) {
    this.#d = deps;
  }

  async #liveWallet(db: Kysely<Database>, userId: string): Promise<LiveWallet | null> {
    const row = await db
      .selectFrom('wallets')
      .select(['id', 'status', 'safe_address'])
      .where('user_id', '=', userId)
      .where('platform_id', '=', this.#d.platformId)
      .where('status', 'not in', LIVE_WALLET_EXCLUDED)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row ? { id: row.id, status: row.status, safe: safeAddressOf(row.safe_address) } : null;
  }

  /** Condiciones de cada scope sobre la wallet viva del usuario; devuelve la wallet a la que se ata la sesión. */
  #walletFor(scope: StepUpScope, wallet: LiveWallet | null): LiveWallet | null {
    switch (scope) {
      case 'ONBOARDING':
        if (wallet?.status === 'ACTIVE') {
          throw new ApiError('CONFLICT', { detail: 'la wallet ya está activa: desbloqueala con tu Password U' });
        }
        return wallet;
      case 'U_REPLACEMENT':
      case 'RECOVERY':
        if (wallet?.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE');
        return wallet;
      case 'ENROLLMENT':
        if (!wallet) throw new ApiError('WALLET_NOT_ACTIVE', { detail: 'todavía no hay una wallet en curso' });
        return wallet;
      case 'KEY_RESTORE':
        if (wallet?.status !== 'ACTIVE' || wallet.safe === null) throw new ApiError('WALLET_NOT_ACTIVE');
        return wallet;
    }
  }

  /** Pide el step-up: envía el código por email atado a la sesión de cuenta, al scope y a la session key. */
  async start(input: {
    session: AuthenticatedSession;
    scope: StepUpScope;
    sessionPublicKey: P256PublicJwk;
    meta: RequestMeta;
  }): Promise<{ challengeId: string; expiresAt: Date; keyRestoreNonce?: Hex }> {
    if (STEP_UP_LISTENER[input.scope] !== input.meta.client) throw new ApiError('SCOPE_NOT_ALLOWED');
    if (input.scope === 'KEY_RESTORE' && this.#d.keyRestore === undefined) throw new ApiError('SCOPE_NOT_ALLOWED');
    const keyRestoreNonce: Hex | undefined =
      input.scope === 'KEY_RESTORE' ? `0x${randomBytes(32).toString('hex')}` : undefined;
    return withTransaction(
      this.#d.db,
      async (trx) => {
        const wallet = this.#walletFor(input.scope, await this.#liveWallet(trx, input.session.userId));
        const user = await trx
          .selectFrom('users')
          .select(['email', 'locale', 'time_zone'])
          .where('id', '=', input.session.userId)
          .executeTakeFirstOrThrow();
        const challenge = await this.#d.challenges.issue(trx, {
          userId: input.session.userId,
          type: 'STEP_UP',
          walletId: wallet?.id ?? null,
          ipPrefix: input.meta.ipPrefix,
          binding: {
            scope: input.scope,
            accountSessionId: input.session.sessionId,
            walletId: wallet?.id ?? null,
            sessionPublicKey: input.sessionPublicKey,
            sessionKeyThumbprint: jwkThumbprint(input.sessionPublicKey),
            ...(keyRestoreNonce === undefined ? {} : { keyRestoreNonce }),
          },
        });
        await this.#d.emails.enqueue(trx, {
          to: user.email,
          template: 'step-up-code',
          params: {
            code: challenge.secret,
            purpose: PURPOSE[input.scope],
            expiresAt: challenge.expiresAt.toISOString(),
            origin: { ipPrefix: input.meta.ipPrefix, userAgent: input.meta.userAgent },
            ...(wallet?.safe ? { safe: wallet.safe } : {}),
          },
          locale: user.locale,
          timeZone: user.time_zone,
          product: input.meta.client === 'WALLET' ? 'Wallet' : 'Recovery',
        });
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: input.session.userId,
          userId: input.session.userId,
          walletId: wallet?.id ?? null,
          sessionId: input.session.sessionId,
          eventType: 'STEP_UP_REQUESTED',
          requestId: input.meta.requestId,
          ipPrefix: input.meta.ipPrefix,
          payload: { client: input.meta.client, scope: input.scope, challengeId: challenge.challengeId },
        });
        return {
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          ...(keyRestoreNonce === undefined ? {} : { keyRestoreNonce }),
        };
      },
      { auditLock: true },
    );
  }

  /**
   * KEY_RESTORE: la prueba de posesión se verifica antes de consumir el código (necesita leer el rol U on-chain, fuera
   * de la transacción). Devuelve la wallet probada o null si el challenge no es de KEY_RESTORE.
   */
  async #keyRestoreProof(input: {
    userId: string;
    challengeId: string;
    keyRestore?: { keyAddress: Address; signature: Hex } | undefined;
  }): Promise<string | null> {
    const row = await this.#d.db
      .selectFrom('security_challenges')
      .select('binding')
      .where('id', '=', input.challengeId)
      .where('user_id', '=', input.userId)
      .where('type', '=', 'STEP_UP')
      .executeTakeFirst();
    const parsed = row ? BindingSchema.safeParse(row.binding) : undefined;
    if (!parsed?.success || parsed.data.scope !== 'KEY_RESTORE') {
      if (input.keyRestore !== undefined)
        throw new ApiError('VALIDATION_FAILED', { detail: 'keyRestore sólo aplica a KEY_RESTORE' });
      return null;
    }
    const binding = parsed.data;
    if (input.keyRestore === undefined) {
      throw new ApiError('VALIDATION_FAILED', {
        detail: 'KEY_RESTORE requiere la prueba de posesión de U (keyRestore)',
      });
    }
    if (this.#d.keyRestore === undefined || binding.walletId === null || binding.keyRestoreNonce === undefined) {
      throw new ApiError('SCOPE_NOT_ALLOWED');
    }
    await this.#d.keyRestore.verifyProof({
      userId: input.userId,
      walletId: binding.walletId,
      keyAddress: input.keyRestore.keyAddress,
      nonce: binding.keyRestoreNonce as Hex,
      signature: input.keyRestore.signature,
    });
    return binding.walletId;
  }

  /**
   * Completa el step-up: código del email (+ TOTP o código de recuperación si está activo) desde la misma sesión de
   * cuenta que lo pidió. Rota la sesión de cuenta y emite la PlatformSession.
   */
  async finish(input: {
    session: AuthenticatedSession;
    challengeId: string;
    code: string;
    totp?: string | undefined;
    recoveryCode?: string | undefined;
    keyRestore?: { keyAddress: Address; signature: Hex } | undefined;
    meta: RequestMeta;
  }): Promise<{ platform: IssuedPlatformSession; account: NewSession }> {
    const userId = input.session.userId;
    const provenWallet = await this.#keyRestoreProof({
      userId,
      challengeId: input.challengeId,
      keyRestore: input.keyRestore,
    });
    const totpEnabled = (
      await this.#d.db.selectFrom('users').select('totp_enabled').where('id', '=', userId).executeTakeFirstOrThrow()
    ).totp_enabled;
    if (totpEnabled && input.totp === undefined && input.recoveryCode === undefined)
      throw new ApiError('SECOND_FACTOR_REQUIRED');
    const wait = await this.#d.account.reauthRetryAfter(userId, input.meta);
    if (wait > 0) throw new ApiError('RATE_LIMITED', { headers: { 'retry-after': String(wait) } });

    // Confirmar y después lanzar: el intento fallido queda contado aunque el request termine en error.
    const outcome = await withTransaction(
      this.#d.db,
      async (trx) => {
        // Con userId: el challenge de otro usuario es NOT_FOUND y no se le cuenta ningún intento.
        const check = await this.#d.challenges.verify(trx, {
          type: 'STEP_UP',
          challengeId: input.challengeId,
          userId,
          secret: input.code,
        });
        if (check.result !== 'OK') {
          await this.#auditFailure(trx, input, { result: check.result });
          return { error: 'INVALID_CODE' as const };
        }
        const binding = BindingSchema.parse(check.binding);
        if (
          binding.accountSessionId !== input.session.sessionId ||
          STEP_UP_LISTENER[binding.scope] !== input.meta.client
        ) {
          await this.#auditFailure(trx, input, { result: 'SESSION_MISMATCH' });
          return { error: 'INVALID_CODE' as const };
        }
        if (totpEnabled && !(await this.#d.account.verifySecondFactor(trx, userId, input))) {
          return { error: 'REAUTH_FAILED' as const };
        }
        // La wallet pudo cambiar entre el pedido y la confirmación (p. ej. se activó): se reevalúa.
        const wallet = this.#walletFor(binding.scope, await this.#liveWallet(trx, userId));
        if ((wallet?.id ?? null) !== binding.walletId) return { error: 'INVALID_CODE' as const };
        // KEY_RESTORE: la prueba (verificada antes) tiene que ser de esta misma wallet.
        if (binding.scope === 'KEY_RESTORE' && provenWallet !== binding.walletId) {
          return { error: 'INVALID_CODE' as const };
        }
        const account = await this.#d.account.rotateSession(trx, userId, input.meta, 'STEP_UP');
        const platform = await this.#d.platformSessions.issue(trx, {
          userId,
          accountSessionId: account.sessionId,
          walletId: wallet?.id ?? null,
          safe: wallet?.safe ?? null,
          scope: binding.scope,
          authMethod: 'STEP_UP',
          sessionPublicKey: binding.sessionPublicKey,
        });
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: userId,
          userId,
          walletId: wallet?.id ?? null,
          sessionId: account.sessionId,
          eventType: 'PLATFORM_SESSION_ISSUED',
          requestId: input.meta.requestId,
          ipPrefix: input.meta.ipPrefix,
          payload: {
            client: input.meta.client,
            platformSessionId: platform.claims.sessionId,
            scope: binding.scope,
            authMethod: 'STEP_UP',
            challengeId: input.challengeId,
          },
        });
        return { platform, account };
      },
      { auditLock: true },
    );
    if ('error' in outcome) {
      if (outcome.error === 'REAUTH_FAILED') {
        await this.#d.account.recordReauthFailure(userId, input.meta, 'step_up_second_factor');
      }
      this.#d.metrics.authFailures.inc({
        reason: outcome.error === 'REAUTH_FAILED' ? 'step_up_second_factor' : 'step_up_code',
      });
      throw new ApiError(outcome.error);
    }
    return outcome;
  }

  async #auditFailure(
    trx: Parameters<AuditWriter['append']>[0],
    input: { session: AuthenticatedSession; challengeId: string; meta: RequestMeta },
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.#d.audit.append(trx, {
      actorType: 'USER',
      actorId: input.session.userId,
      userId: input.session.userId,
      sessionId: input.session.sessionId,
      eventType: 'STEP_UP_FAILED',
      requestId: input.meta.requestId,
      ipPrefix: input.meta.ipPrefix,
      payload: { client: input.meta.client, challengeId: input.challengeId, ...payload },
    });
  }
}
