// Clientes de las APIs reales del stack desde Node, con el ApiClient de la app Recovery (mismo protocolo en los dos
// listeners: cookies de sesión, CSRF y requests críticos firmados por la session key) sobre un fetch con cookie jar
// propio y el header Origin que pondría el navegador de cada app.
import { ApiClient } from '../../../frontend/recovery/src/api/client.ts';
import { RecoveryApi } from '../../../frontend/recovery/src/api/recovery-api.ts';
import { recoveryOrigin, stack, walletOrigin } from '../stack.ts';

/** fetch con cookie jar propio (como un navegador aparte) y Origin fijo. */
export function browserLikeFetch(origin: string): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    if (jar.size > 0) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await fetch(input, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
}

/** Cliente del listener de Wallet (la parte de la app Wallet que los tests hacen por API). */
export function walletClient(): ApiClient {
  return new ApiClient(stack().urls.apiWallet, { fetch: browserLikeFetch(walletOrigin()) });
}

/** API del listener de Recovery con su propia sesión de cuenta. */
export function recoveryApi(): RecoveryApi {
  return new RecoveryApi(new ApiClient(stack().urls.apiRecovery, { fetch: browserLikeFetch(recoveryOrigin()) }));
}

export function uniqueEmail(prefix = 'p19'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}@mtw-browser.test`;
}

export const ACCOUNT_PASSWORD = 'Contraseña de cuenta de prueba 2026!';
