// Challenges de seguridad (`security_challenges`): verificación de email, reset de password y desbloqueo de cuenta
// (P09), step-up de PlatformSession (P10); whitelist, rotaciones y operaciones de alto valor en las fases siguientes.
//
// - Un challenge nuevo del mismo usuario y tipo invalida los anteriores abiertos (un solo código vigente).
// - Verificación con la fila bloqueada (FOR UPDATE): el contador de intentos sube aunque el código sea incorrecto y
//   el challenge se consume al acertar (un solo uso). La transacción del llamador debe confirmarse también en el
//   error, para que el intento quede contado.
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Secret } from '../config/secret.ts';
import type { Database, SecurityChallengesTable } from '../db/schema.ts';
import { generateOtp, generateSecretToken, hashChallengeSecret, secretsMatch } from './otp.ts';

export type ChallengeType = SecurityChallengesTable['type'];

interface ChallengePolicy {
  ttlMinutes: number;
  maxAttempts: number;
  kind: 'otp' | 'token';
}

/** TTL e intentos por tipo ([B-AUTH-02], [B-AUTH-07], [B-AUTH-08], [B-PSES-03]). */
export const CHALLENGE_POLICIES: Readonly<Partial<Record<ChallengeType, ChallengePolicy>>> = {
  EMAIL_VERIFY: { ttlMinutes: 15, maxAttempts: 5, kind: 'otp' },
  LOGIN_UNLOCK: { ttlMinutes: 15, maxAttempts: 5, kind: 'otp' },
  PASSWORD_RESET: { ttlMinutes: 30, maxAttempts: 5, kind: 'token' },
  // Step-up de PlatformSession [B-PSES-03]: más corto (abre una sesión sensible).
  STEP_UP: { ttlMinutes: 10, maxAttempts: 5, kind: 'otp' },
};

export type ChallengeResult = 'OK' | 'INVALID' | 'EXPIRED' | 'EXHAUSTED' | 'NOT_FOUND';

export interface IssuedChallenge {
  challengeId: string;
  /** OTP o token en claro: sólo para enviarlo por email; nunca se guarda ni se loguea. */
  secret: string;
  expiresAt: Date;
}

function policyFor(type: ChallengeType): ChallengePolicy {
  const policy = CHALLENGE_POLICIES[type];
  if (!policy) throw new Error(`challenge ${type} sin política definida`);
  return policy;
}

export class ChallengeService {
  readonly #key: Secret<Buffer>;

  constructor(otpHmacKey: Secret<Buffer>) {
    this.#key = otpHmacKey;
  }

  async issue(
    trx: Transaction<Database>,
    input: {
      userId: string;
      type: ChallengeType;
      walletId?: string | null;
      binding?: Record<string, unknown>;
      ipPrefix?: string | null;
    },
  ): Promise<IssuedChallenge> {
    const policy = policyFor(input.type);
    await trx
      .updateTable('security_challenges')
      .set({ expires_at: sql`now()` })
      .where('user_id', '=', input.userId)
      .where('type', '=', input.type)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .execute();
    const challengeId = randomUUID();
    const secret = policy.kind === 'otp' ? generateOtp() : generateSecretToken();
    const expiresAt = new Date(Date.now() + policy.ttlMinutes * 60_000);
    await trx
      .insertInto('security_challenges')
      .values({
        id: challengeId,
        user_id: input.userId,
        wallet_id: input.walletId ?? null,
        type: input.type,
        binding: JSON.stringify(input.binding ?? {}),
        code_hash: hashChallengeSecret(this.#key, challengeId, secret),
        max_attempts: policy.maxAttempts,
        expires_at: expiresAt,
        created_ip_prefix: input.ipPrefix ?? null,
      })
      .execute();
    return { challengeId, secret, expiresAt };
  }

  /**
   * Verifica un código. Sin `challengeId` se usa el challenge abierto más reciente del usuario y tipo (OTP por email);
   * con `challengeId` (token de reset) ese challenge, que además debe ser del tipo pedido.
   */
  async verify(
    trx: Transaction<Database>,
    input: { type: ChallengeType; secret: string } & (
      { userId: string; challengeId?: undefined } | { challengeId: string; userId?: string }
    ),
  ): Promise<{ result: ChallengeResult; userId?: string; challengeId?: string; binding?: unknown }> {
    let query = trx
      .selectFrom('security_challenges')
      .selectAll()
      .where('type', '=', input.type)
      .orderBy('created_at', 'desc')
      .limit(1)
      .forUpdate();
    if (input.challengeId !== undefined) query = query.where('id', '=', input.challengeId);
    if (input.userId !== undefined) query = query.where('user_id', '=', input.userId);
    if (input.challengeId === undefined) query = query.where('consumed_at', 'is', null);
    const row = await query.executeTakeFirst();
    if (!row || row.consumed_at !== null) return { result: 'NOT_FOUND' };
    if (row.expires_at.getTime() <= Date.now()) return { result: 'EXPIRED', userId: row.user_id, challengeId: row.id };
    if (row.attempts >= row.max_attempts) return { result: 'EXHAUSTED', userId: row.user_id, challengeId: row.id };

    const ok = secretsMatch(row.code_hash, hashChallengeSecret(this.#key, row.id, input.secret));
    await trx
      .updateTable('security_challenges')
      .set({ attempts: sql`attempts + 1`, ...(ok ? { consumed_at: sql`now()` } : {}) })
      .where('id', '=', row.id)
      .execute();
    // El binding (a qué quedó atado el challenge) sólo se entrega con el código correcto.
    if (ok) return { result: 'OK', userId: row.user_id, challengeId: row.id, binding: row.binding };
    return {
      result: row.attempts + 1 >= row.max_attempts ? 'EXHAUSTED' : 'INVALID',
      userId: row.user_id,
      challengeId: row.id,
    };
  }

  /** Invalida todos los challenges abiertos de un tipo (p. ej. tokens de reset al completar el reset). */
  async invalidate(trx: Transaction<Database>, userId: string, type: ChallengeType): Promise<void> {
    await trx
      .updateTable('security_challenges')
      .set({ expires_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('type', '=', type)
      .where('consumed_at', 'is', null)
      .execute();
  }
}
