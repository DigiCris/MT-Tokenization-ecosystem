// Lo único que sobrevive a la redirección de OAuth ([F-DRV-01]): el `state` aleatorio y la ruta de regreso, en
// sessionStorage (pestaña actual) sólo durante el viaje de ida y vuelta. Nunca claves, sobres ni tokens. Es uno de los
// dos módulos con Web Storage permitido (regla Semgrep mtw-fe-web-storage).

const KEY = 'mtw.oauth.google';
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
