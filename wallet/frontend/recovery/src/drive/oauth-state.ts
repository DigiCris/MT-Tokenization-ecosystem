// Lo único que sobrevive a la redirección de OAuth de Recovery ([F-DRV-01]): el `state` aleatorio y la ruta de regreso,
// en sessionStorage (pestaña actual) sólo durante el viaje de ida y vuelta. Nunca claves, sobres ni tokens. Es uno de
// los dos módulos con Web Storage permitido.
//
// Excepción documentada (ADR-033; revisión de seguridad de ADR-033, BAJO 3): en `/enroll`, la ruta de regreso lleva el
// pedido de la app Wallet en el fragmento —`eid`, `n` y el secreto `k`—, porque al volver de Google la página tiene que
// armar el enlace de regreso con el mismo `k` (sin él, la Wallet lo trata como un enlace falsificado y aborta el pedido).
// Un hash de `k` no alcanza (el enlace lleva `k` en claro) y no guardarlo dejaría a todo pedido que conecta Drive sin
// enlace de regreso. Así que `k` queda acá sólo mientras dura el viaje: se borra al volver (un solo uso), vence a los
// 10 minutos, y un viaje abandonado se descarta al arrancar la app fuera del callback, al volver la página del bfcache y
// al montar `/enroll` (discardOAuthState). `k` no sirve sin la pestaña del pedido de la Wallet y un backend comprometido.

const KEY = 'mtw.recovery.oauth.google';
/** Un viaje de ida y vuelta más largo que esto se descarta. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface OAuthState {
  state: string;
  returnTo: string;
  createdAt: number;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveOAuthState(value: OAuthState): void {
  const target = storage();
  if (target === null) throw new Error('el navegador no permite guardar el estado de la conexión con Drive');
  target.setItem(KEY, JSON.stringify(value));
}

/** Descarta el estado de un viaje que no volvió por el callback (abandonado): no queda nada en la pestaña. */
export function discardOAuthState(): void {
  storage()?.removeItem(KEY);
}

/** Lee y borra el estado (un solo uso); null si no hay, está mal formado o venció. */
export function takeOAuthState(now: number = Date.now()): OAuthState | null {
  const target = storage();
  if (target === null) return null;
  const raw = target.getItem(KEY);
  target.removeItem(KEY);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<OAuthState>;
    if (
      typeof value.state !== 'string' ||
      typeof value.returnTo !== 'string' ||
      typeof value.createdAt !== 'number' ||
      !value.returnTo.startsWith('/') ||
      value.returnTo.startsWith('//') ||
      now - value.createdAt > OAUTH_STATE_TTL_MS ||
      value.createdAt > now + 60_000
    ) {
      return null;
    }
    return { state: value.state, returnTo: value.returnTo, createdAt: value.createdAt };
  } catch {
    return null;
  }
}
