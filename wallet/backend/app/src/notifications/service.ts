// Notificaciones in-app del usuario ([B-MAIL-03], grupo `notifications` de [B-API]): lectura paginada por cursor (más
// recientes primero) y marca de leída. Las crea `notify()` dentro de la transacción del cambio que las origina; el
// payload nunca lleva secretos (direcciones, montos, momentos y el id del recurso).
import { sql, type Kysely, type Selectable } from 'kysely';
import { ApiError } from '../api/errors.ts';
import type { Database, NotificationsTable } from '../db/schema.ts';
import { isUuid } from '../operations/wallet-access.ts';

type NotificationRow = Selectable<NotificationsTable>;

export interface NotificationView {
  id: string;
  walletId: string | null;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

function view(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    walletId: row.wallet_id,
    type: row.type,
    payload: row.payload as Record<string, unknown>,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class NotificationService {
  readonly #db: Kysely<Database>;

  constructor(deps: { db: Kysely<Database> }) {
    this.#db = deps.db;
  }

  /** GET /notifications: las del usuario, más recientes primero; `before` es el id de la última de la página anterior. */
  async list(
    userId: string,
    options: { limit: number; before?: string; unreadOnly?: boolean },
  ): Promise<{ items: NotificationView[]; unread: number; nextCursor: string | null }> {
    let query = this.#db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1);
    if (options.unreadOnly === true) query = query.where('read_at', 'is', null);
    if (options.before !== undefined) {
      const before = options.before;
      const cursor = await this.#db
        .selectFrom('notifications')
        .select('id')
        .where('id', '=', before)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!cursor) throw new ApiError('NOT_FOUND', { detail: 'cursor inexistente' });
      // Comparación en SQL: created_at tiene microsegundos y un Date de JS los perdería (varias notificaciones de una
      // misma transacción comparten el timestamp).
      query = query.where(
        sql<boolean>`(created_at, id) < (SELECT created_at, id FROM notifications WHERE id = ${before})`,
      );
    }
    const rows = await query.execute();
    const unread = await this.#db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    const page = rows.slice(0, options.limit);
    return {
      items: page.map(view),
      unread: Number(unread.n),
      nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** POST /notifications/{id}/read: idempotente (una ya leída conserva su momento de lectura). */
  async markRead(userId: string, notificationId: string): Promise<NotificationView> {
    if (!isUuid(notificationId)) throw new ApiError('NOT_FOUND');
    const updated = await this.#db
      .updateTable('notifications')
      .set({ read_at: sql<Date>`coalesce(read_at, now())` })
      .where('id', '=', notificationId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ApiError('NOT_FOUND');
    return view(updated);
  }
}
