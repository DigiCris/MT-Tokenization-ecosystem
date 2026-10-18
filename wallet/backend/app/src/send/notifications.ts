// Notificación de operación de alto valor ejecutada ([B-MAIL-03], P14.T03): cada SEND que exigió 2FA (monto ≥ umbral)
// y quedó confirmado on-chain genera una notificación in-app y el email `high-value-executed`, una sola vez por
// operación (clave de deduplicación) aunque lo detecten varios workers.
import { sql, type Kysely } from 'kysely';
import { formatUnits, getAddress } from 'viem';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox } from '../email/email-outbox.ts';
import { bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Metrics } from '../observability/metrics.ts';
import { notify } from '../notifications/notify.ts';
import type { CanonicalIntent } from '../operations/intent.ts';

export interface HighValueNotifierDeps {
  db: Kysely<Database>;
  emails: EmailOutbox | null;
  metrics?: Metrics;
}

export const highValueDedupeKey = (operationId: string) => `HIGH_VALUE_EXECUTED:${operationId}`;

export class HighValueNotifier {
  readonly #d: HighValueNotifierDeps;

  constructor(deps: HighValueNotifierDeps) {
    this.#d = deps;
  }

  async runOnce(): Promise<number> {
    const rows = await this.#d.db
      .selectFrom('wallet_operations as o')
      .innerJoin('users as u', 'u.id', 'o.user_id')
      .select([
        'o.id',
        'o.user_id',
        'o.wallet_id',
        'o.safe_address',
        'o.canonical_intent',
        'o.tx_hash',
        'o.confirmed_at',
        'u.email',
        'u.locale',
        'u.time_zone',
      ])
      .where('o.operation_type', '=', 'SEND')
      .where('o.requires_two_factor', '=', true)
      .where('o.status', 'in', ['CONFIRMED', 'FINALIZED'])
      .where('o.confirmed_at', '>', sql<Date>`now() - interval '7 days'`)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('notifications as n')
              .select('n.id')
              .where('n.dedupe_key', '=', sql<string>`'HIGH_VALUE_EXECUTED:' || o.id::text`),
          ),
        ),
      )
      .limit(100)
      .execute();
    let sent = 0;
    for (const row of rows) {
      const decoded = (row.canonical_intent as CanonicalIntent).decoded;
      if (decoded.token === undefined || decoded.amount === undefined || decoded.destination === undefined) continue;
      const params = {
        safe: bufferToAddress(row.safe_address),
        token: decoded.token,
        amount: formatUnits(BigInt(decoded.amount), 6),
        destination: getAddress(decoded.destination),
        txHash: row.tx_hash === null ? '' : bufferToHex(row.tx_hash),
        occurredAt: (row.confirmed_at ?? new Date()).toISOString(),
      };
      const created = await withTransaction(this.#d.db, async (trx) => {
        const inserted = await notify(
          trx,
          {
            userId: row.user_id,
            walletId: row.wallet_id,
            type: 'HIGH_VALUE_EXECUTED',
            payload: { operationId: row.id, ...params },
            dedupeKey: highValueDedupeKey(row.id),
          },
          this.#d.metrics,
        );
        if (inserted) {
          await this.#d.emails?.enqueue(trx, {
            to: row.email,
            template: 'high-value-executed',
            params,
            locale: row.locale,
            timeZone: row.time_zone,
            product: 'Wallet',
          });
        }
        return inserted;
      });
      if (created) sent++;
    }
    return sent;
  }
}
