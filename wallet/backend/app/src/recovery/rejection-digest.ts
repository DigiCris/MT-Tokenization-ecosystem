// Resumen de los avisos de rechazo de enrollments de R (revisión de seguridad de ADR-033, BAJO 8): cada aviso de la
// Wallet deja su auditoría, su notificación in-app, la alerta y la métrica, pero el email de seguridad sale uno por
// ventana y usuario (`REJECTION_EMAIL_WINDOW_MS`): el primero en el momento y los siguientes de la ventana quedan
// retenidos (HELD). Al cerrarse la ventana, esta pasada del worker los manda juntos en un solo email y los marca
// SUMMARIZED; ese resumen abre una ventana nueva. Así nadie con la sesión del usuario puede convertir cada pedido en un
// email (crear y rechazar pedidos, o avisos tardíos), y el usuario igual se entera de todos.
import type { Kysely } from 'kysely';
import { getAddress } from 'viem';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import type { RecoveryEnrollmentRejection } from '../email/templates.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { Logger } from '../observability/logger.ts';
import { lastRejectionEmail, REJECTION_EMAIL_WINDOW_MS, WALLET_REJECTION_REASONS } from './enrollment.ts';

export interface RejectionDigestDeps {
  db: Kysely<Database>;
  emails: EmailOutbox | null;
  logger: Logger;
  now?: () => number;
}

const isWalletReason = (reason: string | null): reason is RecoveryEnrollmentRejection =>
  (WALLET_REJECTION_REASONS as readonly string[]).includes(reason ?? '');

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
    const users = await this.#d.db
      .selectFrom('recovery_metadata as r')
      .innerJoin('wallets as w', 'w.id', 'r.wallet_id')
      .select('w.user_id')
      .distinct()
      .where('r.rejection_email', '=', 'HELD')
      .limit(100)
      .execute();
    let sent = 0;
    for (const { user_id: userId } of users) {
      // El rechazo y el resumen toman el lock de auditoría: un aviso nuevo no se cruza con el resumen.
      const summary = await withTransaction(
        this.#d.db,
        async (trx) => {
          const now = this.#now();
          const last = await lastRejectionEmail(trx, userId);
          if (last !== null && now - last.getTime() < REJECTION_EMAIL_WINDOW_MS) return null;
          const held = await trx
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
            .execute();
          const first = held[0];
          const latest = held.at(-1);
          if (first === undefined || latest === undefined) return null;
          const user = await trx
            .selectFrom('users')
            .select(['email', 'locale', 'time_zone'])
            .where('id', '=', userId)
            .executeTakeFirstOrThrow();
          const reasons = [...new Set(held.map((r) => r.rejection_reason).filter(isWalletReason))];
          const wallets = new Set(held.map((r) => r.wallet_id));
          const safe = wallets.size === 1 && first.safe_address !== null ? bufferToAddress(first.safe_address) : null;
          const emailedAt = new Date(now);
          await emails.enqueue(trx, {
            to: user.email,
            template: 'recovery-enrollment-rejections-summary',
            params: {
              count: held.length,
              reasons,
              replacement: held.some((r) => r.purpose === 'REPLACEMENT'),
              safe: safe === null ? null : getAddress(safe),
              firstAt: (first.rejection_reported_at ?? emailedAt).toISOString(),
              lastAt: (latest.rejection_reported_at ?? emailedAt).toISOString(),
            },
            locale: user.locale,
            timeZone: user.time_zone,
            product: 'Wallet',
          });
          await trx
            .updateTable('recovery_metadata')
            .set({ rejection_email: 'SUMMARIZED', rejection_emailed_at: emailedAt })
            .where(
              'id',
              'in',
              held.map((r) => r.id),
            )
            .execute();
          return { count: held.length };
        },
        { auditLock: true },
      );
      if (summary !== null) {
        sent++;
        this.#d.logger.info({ userId, count: summary.count }, 'resumen de rechazos de enrollments de R encolado');
      }
    }
    return sent;
  }
}
