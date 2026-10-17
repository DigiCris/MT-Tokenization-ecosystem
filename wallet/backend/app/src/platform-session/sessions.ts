// PlatformSessions en la base [B-PSES-01]: cada token emitido tiene su fila en `platform_sessions` (revocable). Un token
// sólo vale si su fila existe, no está revocada ni vencida, coincide con sus claims y su sesión de cuenta padre es la
// del request (revocar la sesión de cuenta revoca sus PlatformSessions, P09).
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { getAddress, toHex, type Address } from 'viem';
import type { Database } from '../db/schema.ts';
import type { P256PublicJwk } from './keys.ts';
import {
  PLATFORM_SESSION_AUDIENCE,
  PLATFORM_SESSION_TTL_SECONDS,
  PlatformSessionTokenError,
  type PlatformAuthMethod,
  type PlatformScope,
  type PlatformSessionClaims,
  type PlatformSessionIssuer,
} from './token.ts';

export interface IssuedPlatformSession {
  token: string;
  claims: PlatformSessionClaims;
}

export interface VerifiedPlatformSession {
  token: string;
  claims: PlatformSessionClaims;
}

export type PlatformSessionProblem = 'INVALID' | 'REVOKED' | 'ACCOUNT_MISMATCH';

export class PlatformSessionError extends Error {
  override name = 'PlatformSessionError';
  readonly problem: PlatformSessionProblem;

  constructor(problem: PlatformSessionProblem) {
    super(`PlatformSession inválida (${problem})`);
    this.problem = problem;
  }
}

/** Dirección de una Safe guardada como bytea (eth_address) → checksum EIP-55. */
export function safeAddressOf(bytes: Buffer | null): Address | null {
  return bytes === null ? null : getAddress(toHex(bytes));
}

export class PlatformSessionService {
  readonly #db: Kysely<Database>;
  readonly #issuer: PlatformSessionIssuer;
  readonly #platformId: string;

  constructor(deps: { db: Kysely<Database>; issuer: PlatformSessionIssuer; platformId: string }) {
    this.#db = deps.db;
    this.#issuer = deps.issuer;
    this.#platformId = deps.platformId;
  }

  /** Emite una PlatformSession de 15 min dentro de la transacción del llamador. */
  async issue(
    trx: Transaction<Database>,
    input: {
      userId: string;
      accountSessionId: string;
      walletId: string | null;
      safe: Address | null;
      scope: PlatformScope;
      authMethod: PlatformAuthMethod;
      sessionPublicKey: P256PublicJwk;
    },
  ): Promise<IssuedPlatformSession> {
    const sessionId = randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + PLATFORM_SESSION_TTL_SECONDS;
    await trx
      .insertInto('platform_sessions')
      .values({
        id: sessionId,
        account_session_id: input.accountSessionId,
        user_id: input.userId,
        wallet_id: input.walletId,
        scope: input.scope,
        auth_method: input.authMethod,
        session_public_key_jwk: JSON.stringify(input.sessionPublicKey),
        issued_at: new Date(issuedAt * 1000),
        expires_at: new Date(expiresAt * 1000),
      })
      .execute();
    const claims: PlatformSessionClaims = {
      userId: input.userId,
      walletId: input.walletId,
      safe: input.safe,
      platformId: this.#platformId,
      sessionPublicKey: input.sessionPublicKey,
      sessionId,
      issuedAt,
      expiresAt,
      scope: input.scope,
      authMethod: input.authMethod,
      accountSessionId: input.accountSessionId,
      aud: [...PLATFORM_SESSION_AUDIENCE],
    };
    return { token: await this.#issuer.sign(claims), claims };
  }

  /**
   * Valida un token del header contra la base y contra la sesión de cuenta del request. Lanza
   * PlatformSessionTokenError (firma, audiencia, vigencia) o PlatformSessionError (fila, revocación, cuenta).
   */
  async authenticate(
    token: string,
    account: { sessionId: string; userId: string },
    now = Date.now(),
  ): Promise<VerifiedPlatformSession> {
    const claims = await this.#issuer.verify(token, now);
    if (claims.platformId !== this.#platformId) throw new PlatformSessionTokenError('AUDIENCE');
    if (claims.accountSessionId !== account.sessionId || claims.userId !== account.userId) {
      throw new PlatformSessionError('ACCOUNT_MISMATCH');
    }
    const row = await this.#db
      .selectFrom('platform_sessions')
      .select([
        'id',
        'user_id',
        'account_session_id',
        'wallet_id',
        'scope',
        'auth_method',
        'session_public_key_jwk',
        'issued_at',
        'expires_at',
        'revoked_at',
      ])
      .where('id', '=', claims.sessionId)
      .executeTakeFirst();
    if (!row) throw new PlatformSessionError('INVALID');
    if (row.revoked_at !== null || row.expires_at.getTime() <= now) throw new PlatformSessionError('REVOKED');
    // Defensa en profundidad: lo firmado tiene que coincidir con lo registrado.
    const jwk = row.session_public_key_jwk as P256PublicJwk;
    const matches =
      row.user_id === claims.userId &&
      row.account_session_id === claims.accountSessionId &&
      row.wallet_id === claims.walletId &&
      row.scope === claims.scope &&
      row.auth_method === claims.authMethod &&
      Math.floor(row.issued_at.getTime() / 1000) === claims.issuedAt &&
      Math.floor(row.expires_at.getTime() / 1000) === claims.expiresAt &&
      jwk.x === claims.sessionPublicKey.x &&
      jwk.y === claims.sessionPublicKey.y;
    if (!matches) throw new PlatformSessionError('INVALID');
    return { token, claims };
  }

  /** Revoca una PlatformSession propia; false si no existe, es de otro usuario o ya estaba revocada. */
  async revoke(trx: Transaction<Database>, input: { userId: string; sessionId: string }): Promise<boolean> {
    const result = await trx
      .updateTable('platform_sessions')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', input.sessionId)
      .where('user_id', '=', input.userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
