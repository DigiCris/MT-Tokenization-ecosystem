// Avisos in-app sin leer ([B-MAIL-03], P15.T07) en el inicio: cada uno con su texto, la hora, a dónde ir y "Marcar
// como leído", con el color de su tono (advertencia, error o informativo). Si el backend no responde, el inicio sigue
// sin avisos (los mismos eventos llegan por email). Antes de armar el texto se adaptan para leer los datos que vienen
// del backend (P18.MAN): el label de un destino va entre «» (no se confunde con un nombre de la app) y el prefijo de la
// IP sin la notación de red ("203.0.113.x", no "203.0.113.0/24"). La hora no se repite si el texto ya la dice.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AppNotification } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { CallDescription } from '../operations/CallDescription.tsx';
import { partsText } from '../operations/describe.ts';
import { userLabel, type NameOf } from '../operations/names.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { notificationView } from './notifications.ts';

/** El prefijo de IP que guarda el backend ("203.0.113.0/24", "2001:db8:1::/48") como se lee: "203.0.113.x". */
export function readableIpPrefix(prefix: string): string {
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(prefix);
  if (v4?.[1]) return `${v4[1]}.x`;
  const v6 = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})::\/\d{1,3}$/i.exec(prefix);
  if (v6?.[1]) return `${v6[1]}:…`;
  return prefix;
}

/** Los datos del aviso listos para mostrar: el label entre «» y la IP sin la notación de red. */
export function displayPayload(notification: AppNotification): AppNotification {
  const payload = { ...notification.payload };
  if (typeof payload.label === 'string' && payload.label !== '') payload.label = userLabel(payload.label);
  if (typeof payload.ipPrefix === 'string') payload.ipPrefix = readableIpPrefix(payload.ipPrefix);
  return { ...notification, payload };
}

/** El texto del aviso ya dice cuándo pasó (p. ej. un inicio de sesión): la hora de abajo sobraría. */
function saysWhen(notification: AppNotification, text: string): boolean {
  const occurred = notification.payload.occurredAt;
  if (typeof occurred !== 'string') return false;
  const date = new Date(occurred);
  return !Number.isNaN(date.getTime()) && text.includes(date.toLocaleString('es-AR'));
}

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
          const view = notificationView(displayPayload(notification), nameOf);
          const timeInText = saysWhen(notification, partsText(view.parts));
          return (
            <li key={notification.id} data-notification={notification.type} data-tone={view.tone}>
              <p>
                <CallDescription parts={view.parts} />
              </p>
              <p className="muted">
                {!timeInText && (
                  <>
                    <time dateTime={notification.createdAt}>
                      {new Date(notification.createdAt).toLocaleString('es-AR')}
                    </time>
                    {' · '}
                  </>
                )}
                {view.link && (
                  <>
                    <Link to={view.link.to}>{view.link.label}</Link>
                    {' · '}
                  </>
                )}
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
