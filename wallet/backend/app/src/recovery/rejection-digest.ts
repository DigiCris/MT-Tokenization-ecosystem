// Resumen de los avisos de rechazo retenidos (revisión de seguridad de ADR-033, BAJO 8): cada aviso deja su auditoría,
// su notificación in-app, la alerta y la métrica, pero el email de seguridad sale uno por ventana, usuario y tipo de
// rechazo (rejection-email.ts): el primero en el momento y los siguientes de la ventana quedan retenidos (HELD). Al
// cerrarse la ventana, esta pasada del worker los manda juntos en un solo email y los marca SUMMARIZED; ese resumen abre
// una ventana nueva. Así nadie con la sesión del usuario puede convertir cada pedido en un email (crear y rechazar
// pedidos, o avisos tardíos), y el usuario igual se entera de todos. Cada tipo tiene su resumen: los enrollments de R
// que rechazó la Wallet ([F-LNK-02]) y los borradores del reemplazo de U que rechazó la app Recovery ([F-LNK-04]).
import type { Kysely, Transaction } from 'kysely';
import { getAddress, type Address } from 'viem';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import type { RecoveryEnrollmentRejection, UReplacementRejection } from '../email/templates.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import { WALLET_REJECTION_REASONS } from './enrollment.ts';
import { lastRejectionEmail, REJECTION_EMAIL_WINDOW_MS, type RejectionSource } from './rejection-email.ts';
import { U_REPLACEMENT_REJECTION_REASONS } from './u-replacement.ts';

export interface RejectionDigestDeps {
  db: Kysely<Database>;
  emails: EmailOutbox | null;
  logger: Logger;
  now?: () => number;
}

/** Un aviso retenido, con lo que necesita el resumen. */
interface Held {
  id: string;
  walletId: string;
  safe: Buffer | null;
  reason: string | null;
  reportedAt: Date | null;
  /** Sólo en los enrollments: el reemplazo de R de una wallet activa. */
  replacement: boolean;
}

/** Lo que dice el resumen de la ventana. */
interface Summary {
  count: number;
  /** Motivos distintos, en el orden en que llegaron. */
  reasons: string[];
  replacement: boolean;
  /** La Safe, si todos son de la misma wallet (en el onboarding todavía no existe). */
  safe: Address | null;
  firstAt: string;
  lastAt: string;
}

interface Recipient {
  email: string;
  locale: string;
  time_zone: string;
}

/** Cómo se leen, se resumen y se marcan los avisos retenidos de un tipo de rechazo. */
interface Source {
  name: RejectionSource;
  /** Usuarios con avisos retenidos (de a 100 por pasada). */
  users(db: Kysely<Database>): Promise<string[]>;
  /** Los avisos retenidos del usuario, bloqueados y en el orden en que llegaron. */
  held(trx: Transaction<Database>, userId: string): Promise<Held[]>;
  send(trx: Transaction<Database>, emails: EmailOutbox, user: Recipient, summary: Summary): Promise<void>;
  markSummarized(trx: Transaction<Database>, ids: string[], emailedAt: Date): Promise<void>;
}

const isWalletReason = (reason: string): reason is RecoveryEnrollmentRejection =>
  (WALLET_REJECTION_REASONS as readonly string[]).includes(reason);
const isUReplacementReason = (reason: string): reason is UReplacementRejection =>
  (U_REPLACEMENT_REJECTION_REASONS as readonly string[]).includes(reason);

const SOURCES: readonly Source[] = [
  {
    name: 'R_ENROLLMENT',
    users: async (db) =>
      (
        await db
          .selectFrom('recovery_metadata as r')
          .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
          .select('w.user_id')
          .distinct()
          .where('r.rejection_email', '=', 'HELD')
          .limit(100)
          .execute()
      ).map((r) => r.user_id),
    held: async (trx, userId) =>
      (
        await trx
          .selectFrom('recovery_metadata as r')
          .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
          .select([
            'r.id',
            'r.purpose',
            'r.rejection_reason',
            'r.rejection_reported_at',
            'w.id as wallet_id',
            'w.safe_address',
          ])
          .where('w.user_id', '=', userId)
          .where('r.rejection_email', '=', 'HELD')
          .orderBy('r.rejection_reported_at')
          .forUpdate('r')
          .execute()
      ).map((r) => ({
        id: r.id,
        walletId: r.wallet_id,
        safe: r.safe_address,
        reason: r.rejection_reason,
        reportedAt: r.rejection_reported_at,
        replacement: r.purpose === 'REPLACEMENT',
      })),
    send: async (trx, emails, user, summary) => {
      await emails.enqueue(trx, {
        to: user.email,
        template: 'recovery-enrollment-rejections-summary',
        params: {
          count: summary.count,
          reasons: summary.reasons.filter(isWalletReason),
          replacement: summary.replacement,
          safe: summary.safe,
          firstAt: summary.firstAt,
          lastAt: summary.lastAt,
        },
        locale: user.locale,
        timeZone: user.time_zone,
        product: 'Wallet',
      });
    },
    markSummarized: async (trx, ids, emailedAt) => {
      await trx
        .updateTable('recovery_metadata')
        .set({ rejection_email: 'SUMMARIZED', rejection_emailed_at: emailedAt })
        .where('id', 'in', ids)
        .execute();
    },
  },
  {
    name: 'U_REPLACEMENT',
    users: async (db) =>
      (
        await db
          .selectFrom('rotation_requests as r')
          .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
          .select('w.user_id')
          .distinct()
          .where('r.rejection_email', '=', 'HELD')
          .limit(100)
          .execute()
      ).map((r) => r.user_id),
    held: async (trx, userId) =>
      (
        await trx
          .selectFrom('rotation_requests as r')
          .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
          .select(['r.id', 'r.rejection_reason', 'r.rejected_at', 'w.id as wallet_id', 'w.safe_address'])
          .where('w.user_id', '=', userId)
          .where('r.rejection_email', '=', 'HELD')
          .orderBy('r.rejected_at')
          .forUpdate('r')
          .execute()
      ).map((r) => ({
        id: r.id,
        walletId: r.wallet_id,
        safe: r.safe_address,
        reason: r.rejection_reason,
        reportedAt: r.rejected_at,
        replacement: false,
      })),
    send: async (trx, emails, user, summary) => {
      await emails.enqueue(trx, {
        to: user.email,
        template: 'u-replacement-rejections-summary',
        params: {
          count: summary.count,
          reasons: summary.reasons.filter(isUReplacementReason),
          safe: summary.safe,
          firstAt: summary.firstAt,
          lastAt: summary.lastAt,
        },
        locale: user.locale,
        timeZone: user.time_zone,
        product: 'Recovery',
      });
    },
    markSummarized: async (trx, ids, emailedAt) => {
      await trx
        .updateTable('rotation_requests')
        .set({ rejection_email: 'SUMMARIZED', rejection_emailed_at: emailedAt })
        .where('id', 'in', ids)
        .execute();
    },
  },
];

export class RejectionEmailDigest {
  readonly #d: RejectionDigestDeps;

  constructor(deps: RejectionDigestDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** Manda los resúmenes de las ventanas cerradas; devuelve cuántos emails encoló. */
  async runOnce(): Promise<number> {
    const emails = this.#d.emails;
    if (emails === null) return 0;
    let sent = 0;
    for (const source of SOURCES) {
      for (const userId of await source.users(this.#d.db)) {
        if (await this.#summarize(source, emails, userId)) sent++;
      }
    }
    return sent;
  }

  /** El resumen de un usuario para un tipo de rechazo, si su ventana cerró y tiene avisos retenidos. */
  async #summarize(source: Source, emails: EmailOutbox, userId: string): Promise<boolean> {
    // El rechazo y el resumen toman el lock de auditoría: un aviso nuevo no se cruza con el resumen.
    const summary = await withTransaction(
      this.#d.db,
      async (trx) => {
        const now = this.#now();
        const last = await lastRejectionEmail(trx, userId, source.name);
        if (last !== null && now - last.getTime() < REJECTION_EMAIL_WINDOW_MS) return null;
        const held = await source.held(trx, userId);
        const first = held[0];
        const latest = held.at(-1);
        if (first === undefined || latest === undefined) return null;
        const user = await trx
          .selectFrom('users')
          .select(['email', 'locale', 'time_zone'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        const wallets = new Set(held.map((r) => r.walletId));
        const emailedAt = new Date(now);
        await source.send(trx, emails, user, {
          count: held.length,
          reasons: [...new Set(held.flatMap((r) => (r.reason === null ? [] : [r.reason])))],
          replacement: held.some((r) => r.replacement),
          safe: wallets.size === 1 && first.safe !== null ? getAddress(bufferToAddress(first.safe)) : null,
          firstAt: (first.reportedAt ?? emailedAt).toISOString(),
          lastAt: (latest.reportedAt ?? emailedAt).toISOString(),
        });
        await source.markSummarized(
          trx,
          held.map((r) => r.id),
          emailedAt,
        );
        return { count: held.length };
      },
      { auditLock: true },
    );
    if (summary === null) return false;
    this.#d.logger.info({ userId, source: source.name, count: summary.count }, 'resumen de avisos de rechazo encolado');
    return true;
  }
}
