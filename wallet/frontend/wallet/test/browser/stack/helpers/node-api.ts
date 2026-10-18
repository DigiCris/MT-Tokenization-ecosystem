// Cliente de la API desde Node para preparar escenarios (cuentas verificadas, onboarding hasta ACTIVE): el mismo
// ApiClient/WalletApi de la app sobre un fetch con cookies y el header Origin que pondría el navegador.
import { ApiClient } from '../../../../src/api/client.ts';
import { WalletApi } from '../../../../src/api/wallet-api.ts';
import { stack, walletOrigin } from './stack.ts';

export const RECOVERY_ORIGIN = 'http://localhost:5174';

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

export function walletApi(): WalletApi {
  return new WalletApi(new ApiClient({ baseUrl: stack().urls.apiWallet, fetch: browserLikeFetch(walletOrigin()) }));
}

export function recoveryClient(): ApiClient {
  return new ApiClient({ baseUrl: stack().urls.apiRecovery, fetch: browserLikeFetch(RECOVERY_ORIGIN) });
}

export function uniqueEmail(prefix = 'p17'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}@mtw-browser.test`;
}

export const ACCOUNT_PASSWORD = 'Contraseña de cuenta de prueba 2026!';
