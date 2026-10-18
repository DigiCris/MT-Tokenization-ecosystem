// Deriva de configuración de la Safe (P13.T11, paso 7b de [B-Q-02], [B-FIN-03]): si la configuración on-chain dejó de
// ser la de una wallet asistida (U+R retiraron el Guard, cambiaron el module guard, el fallback, los owners…), la
// plataforma no puede cooperar: la wallet pasa a SOVEREIGN_MODIFIED con los ítems que difieren, queda auditado, el
// usuario recibe una notificación y un email, y se registra la alerta (log de error + métrica). Todo en la transacción
// del llamador; idempotente (una wallet ya marcada no se vuelve a notificar).
import type { Transaction } from 'kysely';
import type { Address } from 'viem';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { ConfigDriftItem } from '../chain/safe-state.ts';
import type { Database } from '../db/schema.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';

export interface SovereignDeps {
  audit: AuditWriter;
  email: EmailOutbox | null;
  logger: Logger;
  metrics?: Metrics;
}

export class SovereignModification {
  readonly #d: SovereignDeps;

  constructor(deps: SovereignDeps) {
    this.#d = deps;
  }

  /** Marca la wallet; devuelve false si ya estaba marcada (o no estaba ACTIVE). */
  async mark(
    trx: Transaction<Database>,
    input: { walletId: string; safe: Address; items: readonly ConfigDriftItem[]; detectedBy: string },
  ): Promise<boolean> {
    if (input.items.length === 0) throw new Error('deriva sin ítems');
    const updated = await trx
      .updateTable('wallets')
      .set({ status: 'SOVEREIGN_MODIFIED', config_drift: JSON.stringify(input.items), config_drift_at: new Date() })
      .where('id', '=', input.walletId)
      .where('status', '=', 'ACTIVE')
      .returning(['user_id'])
      .executeTakeFirst();
    if (!updated) return false;
    const user = await trx
      .selectFrom('users')
      .select(['email', 'locale', 'time_zone'])
      .where('id', '=', updated.user_id)
      .executeTakeFirstOrThrow();
    const occurredAt = new Date().toISOString();
    await this.#d.audit.append(trx, {
      actorType: 'SYSTEM',
      actorId: input.detectedBy,
      userId: updated.user_id,
      walletId: input.walletId,
      eventType: 'WALLET_SOVEREIGN_MODIFIED',
      targetType: 'wallet',
      targetId: input.walletId,
      payload: { safe: input.safe, items: [...input.items] },
    });
    await trx
      .insertInto('notifications')
      .values({
        user_id: updated.user_id,
        wallet_id: input.walletId,
        type: 'SAFE_CONFIG_MODIFIED',
        payload: JSON.stringify({ safe: input.safe, items: input.items, occurredAt }),
      })
      .execute();
    await this.#d.email?.enqueue(trx, {
      to: user.email,
      template: 'safe-config-modified',
      params: { safe: input.safe, items: [...input.items], occurredAt },
      locale: user.locale,
      timeZone: user.time_zone,
      product: 'Wallet',
    });
    this.#d.metrics?.sovereignModified.inc();
    this.#d.logger.error(
      { alert: 'SAFE_CONFIG_MODIFIED', walletId: input.walletId, safe: input.safe, items: input.items },
      'la configuración de la Safe cambió fuera de la plataforma: SOVEREIGN_MODIFIED',
    );
    return true;
  }
}
