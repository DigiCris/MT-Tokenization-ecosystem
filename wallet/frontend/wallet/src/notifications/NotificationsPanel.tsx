// Avisos in-app sin leer ([B-MAIL-03], P15.T07) en el inicio: cada uno con su texto, la hora, a dónde ir y "Marcar
// como leído". Si el backend no responde, el inicio sigue sin avisos (los mismos eventos llegan por email).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AppNotification } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { CallDescription } from '../operations/CallDescription.tsx';
import type { NameOf } from '../operations/names.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { notificationView } from './notifications.ts';

export function NotificationsPanel({ nameOf }: { nameOf?: NameOf }) {
  const [items, setItems] = useState<AppNotification[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .notifications({ unread: true, limit: 20 })
      .then(({ items: unread }) => {
        if (live) setItems(unread);
      })
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const markRead = useAsyncAction(
    useCallback(async (id: string) => {
      await api.markNotificationRead(id);
      setItems((current) => current?.filter((n) => n.id !== id) ?? null);
    }, []),
  );

  if (items === null || items.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="notices-title" data-notifications={items.length}>
      <h2 id="notices-title">Avisos sin leer ({items.length})</h2>
      <ul className="notices">
        {items.map((notification) => {
          const view = notificationView(notification, nameOf);
          return (
            <li key={notification.id} data-notification={notification.type} data-tone={view.tone}>
              <p>
                <CallDescription parts={view.parts} />
              </p>
              <p className="muted">
                <time dateTime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleString('es-AR')}
                </time>
                {view.link && (
                  <>
                    {' · '}
                    <Link to={view.link.to}>{view.link.label}</Link>
                  </>
                )}
                {' · '}
                <button
                  type="button"
                  className="button button--link"
                  disabled={markRead.pending}
                  onClick={() => void markRead.run(notification.id)}
                >
                  Marcar como leído
                </button>
              </p>
            </li>
          );
        })}
      </ul>
      {markRead.error && <Notice tone="error">{markRead.error}</Notice>}
    </section>
  );
}
