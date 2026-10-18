// Operadores de la plataforma ([B-DB], ADR-026): cuentas internas con TOTP obligatorio (RFC 6238, el mismo esquema que
// el 2FA de los usuarios, con anti-replay por paso) para las acciones excepcionales que sólo corren por la CLI de
// operadores (`pnpm operators`, src/operators/cli.ts): la migración excepcional (dos operadores distintos) y el
// reemplazo soberano de una S perdida. El secreto TOTP se guarda cifrado con APP_FIELD_ENCRYPTION_KEY (AES-256-GCM,
// AAD ligado al operador) y el alta lo entrega una sola vez como URI otpauth (la CLI lo escribe en un archivo 0600).
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { AuditWriter } from '../audit/audit-writer.ts';
import { newTotpSecret, totpUri, verifyTotp } from '../auth/totp.ts';
import type { Secret } from '../config/secret.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import { decryptField, encryptField } from '../lib/field-crypto.ts';

export type OperatorErrorCode =
  'OPERATOR_UNKNOWN' | 'OPERATOR_DISABLED' | 'OPERATOR_EXISTS' | 'TOTP_INVALID' | 'TOTP_REPLAY';

export class OperatorError extends Error {
  override name = 'OperatorError';
  readonly code: OperatorErrorCode;
  /** Operador al que corresponde un código TOTP rechazado (para auditar el fallo fuera de la transacción). */
  readonly operatorId: string | null;

  constructor(code: OperatorErrorCode, message: string = code, operatorId: string | null = null) {
    super(message);
    this.code = code;
    this.operatorId = operatorId;
  }
}

export interface OperatorIdentity {
  id: string;
  email: string;
  displayName: string;
}

export interface OperatorCredentials {
  email: string;
  totp: string;
}

const aad = (operatorId: string) => `operator-totp:${operatorId}`;

export class OperatorService {
  readonly #db: Kysely<Database>;
  readonly #fieldKey: Secret<Buffer>;
  readonly #audit: AuditWriter;
  readonly #now: () => number;

  constructor(deps: { db: Kysely<Database>; fieldKey: Secret<Buffer>; audit: AuditWriter; now?: () => number }) {
    this.#db = deps.db;
    this.#fieldKey = deps.fieldKey;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Alta de un operador: devuelve la URI otpauth para enrolar su app autenticadora (se muestra una sola vez). */
  async add(input: {
    email: string;
    displayName: string;
  }): Promise<{ operator: OperatorIdentity; otpauthUri: string }> {
    const email = input.email.trim().toLowerCase();
    const id = randomUUID();
    const secret = newTotpSecret();
    try {
      await withTransaction(
        this.#db,
        async (trx) => {
          const existing = await trx
            .selectFrom('operator_users')
            .select('id')
            .where('email', '=', email)
            .executeTakeFirst();
          if (existing) throw new OperatorError('OPERATOR_EXISTS', `ya existe un operador con ${email}`);
          await trx
            .insertInto('operator_users')
            .values({
              id,
              email,
              display_name: input.displayName,
              totp_secret_ciphertext: encryptField(this.#fieldKey, secret, aad(id)),
            })
            .execute();
          await this.#audit.append(trx, {
            actorType: 'OPERATOR',
            actorId: id,
            eventType: 'OPERATOR_ADDED',
            targetType: 'operator',
            targetId: id,
            payload: { email, displayName: input.displayName },
          });
        },
        { auditLock: true },
      );
      return { operator: { id, email, displayName: input.displayName }, otpauthUri: totpUri(secret, email) };
    } finally {
      secret.fill(0);
    }
  }

  /** Baja lógica: un operador DISABLED no aprueba ni ejecuta acciones. */
  async disable(email: string): Promise<OperatorIdentity> {
    return withTransaction(
      this.#db,
      async (trx) => {
        const row = await trx
          .updateTable('operator_users')
          .set({ status: 'DISABLED' })
          .where('email', '=', email.trim().toLowerCase())
          .returning(['id', 'email', 'display_name'])
          .executeTakeFirst();
        if (!row) throw new OperatorError('OPERATOR_UNKNOWN');
        await this.#audit.append(trx, {
          actorType: 'OPERATOR',
          actorId: row.id,
          eventType: 'OPERATOR_DISABLED',
          targetType: 'operator',
          targetId: row.id,
          payload: { email: row.email },
        });
        return { id: row.id, email: row.email, displayName: row.display_name };
      },
      { auditLock: true },
    );
  }

  /**
   * Corre una acción de operador en una transacción (con el lock de la cadena de auditoría) después de autenticarlo
   * con su TOTP; un código rechazado se audita al terminar la transacción (OPERATOR_AUTH_FAILED).
   */
  async run<T>(
    credentials: OperatorCredentials,
    action: (trx: Transaction<Database>, operator: OperatorIdentity) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTransaction(this.#db, async (trx) => action(trx, await this.authenticate(trx, credentials)), {
        auditLock: true,
      });
    } catch (error) {
      if (error instanceof OperatorError && error.operatorId !== null) await this.#recordFailure(error);
      throw error;
    }
  }

  /** Autentica a un operador antes de una acción con efectos fuera de la base (shards del signer, cadena). */
  async verify(credentials: OperatorCredentials): Promise<OperatorIdentity> {
    return this.run(credentials, (_trx, operator) => Promise.resolve(operator));
  }

  /** Autentica a un operador con su código TOTP dentro de la transacción de la acción (anti-replay por paso). */
  async authenticate(trx: Transaction<Database>, credentials: OperatorCredentials): Promise<OperatorIdentity> {
    const email = credentials.email.trim().toLowerCase();
    const row = await trx
      .selectFrom('operator_users')
      .selectAll()
      .where('email', '=', email)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new OperatorError('OPERATOR_UNKNOWN');
    if (row.status !== 'ACTIVE') throw new OperatorError('OPERATOR_DISABLED');
    const secret = decryptField(this.#fieldKey, row.totp_secret_ciphertext, aad(row.id));
    try {
      const check = verifyTotp(
        secret,
        credentials.totp,
        row.totp_last_used_step === null ? null : BigInt(row.totp_last_used_step),
        this.#now(),
      );
      if (!check.ok) {
        throw new OperatorError(check.reason === 'REPLAY' ? 'TOTP_REPLAY' : 'TOTP_INVALID', undefined, row.id);
      }
      await trx
        .updateTable('operator_users')
        .set({ totp_last_used_step: check.step.toString() })
        .where('id', '=', row.id)
        .execute();
    } finally {
      secret.fill(0);
    }
    return { id: row.id, email: row.email, displayName: row.display_name };
  }

  async #recordFailure(error: OperatorError): Promise<void> {
    await withTransaction(
      this.#db,
      (trx) =>
        this.#audit.append(trx, {
          actorType: 'OPERATOR',
          actorId: error.operatorId,
          eventType: 'OPERATOR_AUTH_FAILED',
          targetType: 'operator',
          targetId: error.operatorId,
          payload: { reason: error.code },
        }),
      { auditLock: true },
    );
  }
}
