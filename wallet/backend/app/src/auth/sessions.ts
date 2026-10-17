// Sesiones de cuenta [B-AUTH-04]: id aleatorio de 256 bits en la cookie `__Host-mtw_sid` (Wallet) o `__Host-mtr_sid`
// (Recovery), HttpOnly, Secure, SameSite=Strict, Path=/; en la base sólo sha256(id). Expiración por inactividad
// (30 min, deslizante) y absoluta (12 h). Una sesión sólo vale en el listener que la creó. Revocar una sesión revoca
// sus PlatformSessions ([B-AUTH-06]).
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AccountStatus, Client, Database } from '../db/schema.ts';

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
/** La inactividad se desliza a lo sumo una vez por minuto (evita una escritura por request). */
const SLIDE_EVERY_MS = 60_000;

export const SESSION_COOKIE: Readonly<Record<Client, string>> = {
  WALLET: '__Host-mtw_sid',
  RECOVERY: '__Host-mtr_sid',
};

export type RevokeReason =
  'LOGOUT' | 'ROTATED' | 'USER_REVOKED' | 'ALL_OTHERS_REVOKED' | 'PASSWORD_RESET' | 'TOTP_CHANGED' | 'STEP_UP';

export interface SessionContext {
  ipPrefix: string | null;
  userAgent: string | null;
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  platformId: string;
  email: string;
  emailVerified: boolean;
  status: AccountStatus;
  client: Client;
  createdAt: Date;
  absoluteExpiresAt: Date;
}

export function sessionTokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class SessionService {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** Crea una sesión nueva; el token en claro sólo va a la cookie. */
  async create(
    trx: Transaction<Database>,
    input: { userId: string; client: Client; context: SessionContext; rotatedFromId?: string | null },
  ): Promise<{ sessionId: string; token: string; absoluteExpiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MS);
    const row = await trx
      .insertInto('sessions')
      .values({
        user_id: input.userId,
        client: input.client,
        token_hash: sessionTokenHash(token),
        idle_expires_at: new Date(now + SESSION_IDLE_MS),
        absolute_expires_at: absoluteExpiresAt,
        rotated_from_id: input.rotatedFromId ?? null,
        ip_prefix: input.context.ipPrefix,
        user_agent: input.context.userAgent?.slice(0, 512) ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { sessionId: row.id, token, absoluteExpiresAt };
  }

  /** Sesión vigente para el token y el listener, o null. Desliza la inactividad. */
  async authenticate(token: string, client: Client): Promise<AuthenticatedSession | null> {
    const row = await this.#db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.user_id',
        's.client',
        's.created_at',
        's.last_seen_at',
        's.idle_expires_at',
        's.absolute_expires_at',
        's.revoked_at',
        'u.platform_id',
        'u.email',
        'u.email_verified_at',
        'u.status',
      ])
      .where('s.token_hash', '=', sessionTokenHash(token))
      .executeTakeFirst();
    const now = Date.now();
    if (
      !row ||
      row.revoked_at !== null ||
      row.client !== client ||
      row.idle_expires_at.getTime() <= now ||
      row.absolute_expires_at.getTime() <= now ||
      row.status === 'DISABLED'
    ) {
      return null;
    }
    if (now - row.last_seen_at.getTime() >= SLIDE_EVERY_MS) {
      await this.#db
        .updateTable('sessions')
        .set({
          last_seen_at: sql`now()`,
          idle_expires_at: sql`least(now() + make_interval(secs => ${SESSION_IDLE_MS / 1000}), absolute_expires_at)`,
        })
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .execute();
    }
    return {
      sessionId: row.id,
      userId: row.user_id,
      platformId: row.platform_id,
      email: row.email,
      emailVerified: row.email_verified_at !== null,
      status: row.status,
      client: row.client,
      createdAt: row.created_at,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  }

  /** Revoca una sesión del usuario y sus PlatformSessions. Devuelve false si no existía o ya estaba revocada. */
  async revoke(
    trx: Transaction<Database>,
    input: { userId: string; sessionId: string; reason: RevokeReason },
  ): Promise<boolean> {
    const result = await trx
      .updateTable('sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: input.reason })
      .where('id', '=', input.sessionId)
      .where('user_id', '=', input.userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    await trx
      .updateTable('platform_sessions')
      .set({ revoked_at: sql`now()` })
      .where('account_session_id', '=', input.sessionId)
      .where('revoked_at', 'is', null)
      .execute();
    return result.numUpdatedRows > 0n;
  }

  /** Revoca todas las sesiones del usuario (salvo `exceptSessionId`) y sus PlatformSessions. */
  async revokeAll(
    trx: Transaction<Database>,
    input: { userId: string; reason: RevokeReason; exceptSessionId?: string },
  ): Promise<number> {
    let query = trx
      .updateTable('sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: input.reason })
      .where('user_id', '=', input.userId)
      .where('revoked_at', 'is', null);
    if (input.exceptSessionId !== undefined) query = query.where('id', '<>', input.exceptSessionId);
    const result = await query.executeTakeFirst();
    let platform = trx
      .updateTable('platform_sessions')
      .set({ revoked_at: sql`now()` })
      .where('user_id', '=', input.userId)
      .where('revoked_at', 'is', null);
    if (input.exceptSessionId !== undefined) {
      platform = platform.where('account_session_id', '<>', input.exceptSessionId);
    }
    await platform.execute();
    return Number(result.numUpdatedRows);
  }

  /** Sesiones vigentes del usuario, la más reciente primero. */
  async list(userId: string) {
    return this.#db
      .selectFrom('sessions')
      .select(['id', 'client', 'created_at', 'last_seen_at', 'ip_prefix', 'user_agent', 'absolute_expires_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('idle_expires_at', '>', sql<Date>`now()`)
      .where('absolute_expires_at', '>', sql<Date>`now()`)
      .orderBy('last_seen_at', 'desc')
      .execute();
  }
}
