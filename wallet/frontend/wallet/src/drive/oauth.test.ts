// @vitest-environment jsdom
// P17.T02 [F-DRV-01]: flujo implícito sin JS de Google (resultado del spike de ADR-012). La ida guarda sólo `state` y
// la ruta de regreso en sessionStorage; la vuelta valida state, error, token_type y scope, limpia el fragmento con
// history.replaceState antes de renderizar y deja el token sólo en memoria (nada en Web Storage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationUrl,
  CALLBACK_PATH,
  completeDriveConnect,
  handleOAuthCallback,
  startDriveConnect,
  takeDriveConnectError,
} from './oauth.ts';
import { OAUTH_STATE_TTL_MS, saveOAuthState, takeOAuthState } from './oauth-state.ts';
import { DRIVE_SCOPE, driveToken, hasDriveToken, revokeDriveToken, setDriveToken } from './token.ts';

const config = {
  clientId: 'cliente-de-prueba.apps.googleusercontent.com',
  redirectUri: 'http://localhost:5173/oauth/google/callback',
};
// Token de prueba sin la forma de un token real de Google (el push protection de GitHub los bloquea).
const TOKEN = 'token-de-prueba-que-no-sirve-para-nada-0123456789';

function storedState(): string {
  const raw = window.sessionStorage.getItem('mtw.oauth.google');
  return (JSON.parse(raw ?? '{}') as { state: string }).state;
}

function fragment(state: string, extra: Record<string, string> = {}) {
  return `#${new URLSearchParams({ access_token: TOKEN, token_type: 'Bearer', expires_in: '3599', scope: DRIVE_SCOPE, state, ...extra }).toString()}`;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(async () => {
  await revokeDriveToken(() => Promise.resolve(new Response(null, { status: 200 })));
  vi.useRealTimers();
});

describe('ida a Google', () => {
  it('URL de autorización: response_type=token, sólo drive.appdata, state y prompt=consent sólo la primera vez', () => {
    const navigate = vi.fn<(url: string) => void>();
    startDriveConnect(config, '/onboarding/key', navigate);
    const url = new URL(navigate.mock.calls[0]?.[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'token',
      scope: DRIVE_SCOPE,
      state: storedState(),
      include_granted_scopes: 'false',
      prompt: 'consent',
    });
    expect(storedState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(authorizationUrl(config, 's', false)).searchParams.has('prompt')).toBe(false);
    expect(() => {
      startDriveConnect(null, '/');
    }).toThrow('no está configurado');
  });
});

describe('vuelta de Google', () => {
  it('token válido: queda en memoria, se marca el consentimiento y no se guarda nada sensible', () => {
    startDriveConnect(config, '/onboarding/key', () => undefined);
    const result = completeDriveConnect(fragment(storedState()));
    expect(result).toEqual({ returnTo: '/onboarding/key', connected: true, error: null });
    expect(driveToken()).toBe(TOKEN);
    expect(window.sessionStorage.length).toBe(0);
    const stored = Array.from({ length: window.localStorage.length }, (_, i) => {
      const key = window.localStorage.key(i) ?? '';
      return `${key}=${window.localStorage.getItem(key) ?? ''}`;
    });
    expect(stored.join('\n')).not.toContain(TOKEN);
    expect(window.localStorage.getItem('mtw.flag.drive.consented')).toBe('yes');
    // El state es de un solo uso: repetir la misma vuelta no vale.
    expect(completeDriveConnect(fragment('cualquiera')).error?.reason).toBe('STATE_MISMATCH');
  });

  it.each([
    ['otro state', (s: string) => fragment(`${s}x`), 'STATE_MISMATCH'],
    ['acceso denegado', (s: string) => `#error=access_denied&state=${s}`, 'DENIED'],
    [
      'otro scope',
      (s: string) => fragment(s, { scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/drive` }),
      'SCOPE',
    ],
    ['token_type distinto', (s: string) => fragment(s, { token_type: 'mac' }), 'MALFORMED'],
    ['sin expires_in', (s: string) => fragment(s, { expires_in: 'x' }), 'MALFORMED'],
    ['token con caracteres raros', (s: string) => fragment(s, { access_token: '<script>' }), 'MALFORMED'],
  ])('%s: se descarta', (_label, build, reason) => {
    startDriveConnect(config, '/unlock', () => undefined);
    const result = completeDriveConnect(build(storedState()));
    expect(result.connected).toBe(false);
    expect(result.error?.reason).toBe(reason);
    expect(result.returnTo).toBe('/unlock');
    expect(hasDriveToken()).toBe(false);
  });

  it('estado vencido o ruta de regreso externa: no se acepta', () => {
    saveOAuthState({ state: 's', returnTo: '/x', createdAt: Date.now() - OAUTH_STATE_TTL_MS - 1 });
    expect(takeOAuthState()).toBeNull();
    saveOAuthState({ state: 's', returnTo: '//evil.example/x', createdAt: Date.now() });
    expect(takeOAuthState()).toBeNull();
    window.sessionStorage.setItem('mtw.oauth.google', '{no es json');
    expect(takeOAuthState()).toBeNull();
    expect(completeDriveConnect('#state=s').returnTo).toBe('/');
  });

  it('el callback se procesa antes de renderizar: la URL queda limpia en la ruta de regreso', () => {
    startDriveConnect(config, '/restore?via=drive', () => undefined);
    window.history.replaceState(null, '', `${CALLBACK_PATH}${fragment(storedState())}`);
    expect(handleOAuthCallback()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/restore?via=drive');
    expect(takeDriveConnectError()).toBeNull();
    expect(driveToken()).toBe(TOKEN);
    window.history.replaceState(null, '', '/otra');
    expect(handleOAuthCallback()).toBe(false);
    window.history.replaceState(null, '', `${CALLBACK_PATH}#error=access_denied`);
    expect(handleOAuthCallback()).toBe(true);
    expect(window.location.href).not.toContain('error');
    expect(takeDriveConnectError()?.reason).toBe('STATE_MISMATCH');
  });
});

describe('token en memoria', () => {
  it('vence con margen y se revoca en Google al descartarlo', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setDriveToken({ accessToken: TOKEN, expiresAt: 1_000_000 + 120_000 });
    expect(driveToken()).toBe(TOKEN);
    expect(driveToken(1_000_000 + 61_000)).toBeNull();
    setDriveToken({ accessToken: TOKEN, expiresAt: 1_000_000 + 3_600_000 });
    const revoke = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
    await revokeDriveToken(revoke);
    expect(hasDriveToken()).toBe(false);
    const [url, init] = revoke.mock.calls[0] ?? [];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init).toMatchObject({ method: 'POST', body: `token=${encodeURIComponent(TOKEN)}`, credentials: 'omit' });
    await revokeDriveToken(revoke);
    expect(revoke).toHaveBeenCalledTimes(1);
    setDriveToken({ accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 });
    await expect(revokeDriveToken(() => Promise.reject(new TypeError('offline')))).resolves.toBeUndefined();
    expect(hasDriveToken()).toBe(false);
  });
});
