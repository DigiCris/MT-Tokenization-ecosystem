// @vitest-environment jsdom
// P19.T03/T08 [F-DRV-01]: OAuth de Google del Drive de Recovery sin JS de Google. La ida guarda sólo `state` y la ruta
// de regreso en sessionStorage; la vuelta valida state, error, token_type y scope, limpia el fragmento con
// history.replaceState antes de renderizar y deja el token sólo en memoria (nada en Web Storage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFlag, readFlag, writeFlag } from '../storage/flags.ts';
import {
  authorizationUrl,
  CALLBACK_PATH,
  completeDriveConnect,
  discardAbandonedOAuthOnRestore,
  handleOAuthCallback,
  startDriveConnect,
  takeDriveConnectError,
} from './oauth.ts';
import { discardOAuthState, OAUTH_STATE_TTL_MS, saveOAuthState, takeOAuthState } from './oauth-state.ts';
import { DRIVE_SCOPE, driveToken, hasDriveToken, revokeDriveToken, setDriveToken } from './token.ts';

const config = {
  clientId: 'cliente-de-prueba.apps.googleusercontent.com',
  redirectUri: 'http://localhost:5174/oauth/google/callback',
};
// Token de prueba sin la forma de un token real de Google (el push protection de GitHub los bloquea).
const TOKEN = 'token-de-prueba-que-no-sirve-para-nada-0123456789';

function storedState(): string {
  const raw = window.sessionStorage.getItem('mtw.recovery.oauth.google');
  return (JSON.parse(raw ?? '{}') as { state: string }).state;
}

function fragment(state: string, extra: Record<string, string> = {}) {
  const params = { access_token: TOKEN, token_type: 'Bearer', expires_in: '3599', scope: DRIVE_SCOPE, state, ...extra };
  return `#${new URLSearchParams(params).toString()}`;
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
  it('response_type=token, sólo drive.appdata, state aleatorio y prompt=consent sólo la primera vez', () => {
    const navigate = vi.fn<(url: string) => void>();
    startDriveConnect(config, '/restore', navigate);
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
  it('con el state guardado y el scope pedido, el token queda en memoria y se vuelve a la ruta de origen', () => {
    startDriveConnect(config, '/restore', () => undefined);
    const result = completeDriveConnect(fragment(storedState()));
    expect(result).toEqual({ returnTo: '/restore', connected: true, error: null });
    expect(driveToken()).toBe(TOKEN);
    expect(readFlag('drive.consented')).toBe('yes');
    // Ni el token ni el state quedan en Web Storage.
    const stored = [window.localStorage, window.sessionStorage]
      .flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`))
      .join('\n');
    expect(stored).not.toContain(TOKEN);
    expect(window.sessionStorage.length).toBe(0);
  });

  it.each([
    ['otro state', (state: string) => fragment(`${state}x`), 'STATE_MISMATCH'],
    ['acceso denegado', (state: string) => `#state=${state}&error=access_denied`, 'DENIED'],
    ['token mal formado', (state: string) => fragment(state, { access_token: 'corto' }), 'MALFORMED'],
    ['sin Bearer', (state: string) => fragment(state, { token_type: 'mac' }), 'MALFORMED'],
    ['scope de más', (state: string) => fragment(state, { scope: `${DRIVE_SCOPE} openid` }), 'SCOPE'],
  ])('%s: no se conecta', (_, build, reason) => {
    startDriveConnect(config, '/restore', () => undefined);
    const result = completeDriveConnect(build(storedState()));
    expect(result.connected).toBe(false);
    expect(result.error?.reason).toBe(reason);
    expect(hasDriveToken()).toBe(false);
  });

  it('un state vencido o una ruta de regreso a otro origin se descartan', () => {
    saveOAuthState({ state: 's', returnTo: '/restore', createdAt: Date.now() - OAUTH_STATE_TTL_MS - 1 });
    expect(takeOAuthState()).toBeNull();
    saveOAuthState({ state: 's', returnTo: '//evil.example/', createdAt: Date.now() });
    expect(takeOAuthState()).toBeNull();
  });

  it('el callback se procesa antes de renderizar y la URL queda limpia', () => {
    startDriveConnect(config, '/enroll#eid=x', () => undefined);
    const replaceState = vi.fn<History['replaceState']>();
    const handled = handleOAuthCallback(
      { pathname: CALLBACK_PATH, hash: fragment(storedState()) } as Location,
      { replaceState } as unknown as History,
    );
    expect(handled).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/enroll#eid=x');
    expect(takeDriveConnectError()).toBeNull();
    expect(handleOAuthCallback({ pathname: '/restore', hash: '' } as Location)).toBe(false);
  });

  it('un viaje abandonado no deja su estado (con el k del pedido): al arrancar fuera del callback y al volver del bfcache', () => {
    // ADR-033: la ruta de regreso de /enroll lleva el secreto k del pedido de la Wallet durante el viaje.
    const returnTo = '/enroll#eid=0f0e0d0c-0b0a-4908-8706-050403020100&n=0xab&k=q1Zs-0bM4_Lr8xWp2cYtNg';
    startDriveConnect(config, returnTo, () => undefined);
    expect(window.sessionStorage.getItem('mtw.recovery.oauth.google')).toContain('q1Zs-0bM4_Lr8xWp2cYtNg');
    // El usuario no completó el consentimiento y volvió a abrir la app (no por el callback): no queda nada.
    expect(handleOAuthCallback({ pathname: '/enroll', hash: '' } as Location)).toBe(false);
    expect(window.sessionStorage.length).toBe(0);

    // «Atrás» desde Google devuelve la página del bfcache: tampoco queda.
    const stop = discardAbandonedOAuthOnRestore();
    try {
      startDriveConnect(config, returnTo, () => undefined);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      expect(window.sessionStorage.length).toBe(1);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      stop();
    }
    startDriveConnect(config, returnTo, () => undefined);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(window.sessionStorage.length).toBe(1);
    discardOAuthState();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('token', () => {
  it('vence con margen y se revoca en Google al descartarlo', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setDriveToken({ accessToken: TOKEN, expiresAt: Date.now() + 120_000 });
    expect(driveToken()).toBe(TOKEN);
    vi.setSystemTime(Date.now() + 61_000);
    expect(driveToken()).toBeNull();
    setDriveToken({ accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
    await revokeDriveToken(fetcher);
    expect(hasDriveToken()).toBe(false);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init?.body).toBe(`token=${TOKEN}`);
  });
});

describe('flags no sensibles', () => {
  it('se leen, escriben y borran con prefijo propio', () => {
    writeFlag('x', '1');
    expect(window.localStorage.getItem('mtw.recovery.flag.x')).toBe('1');
    expect(readFlag('x')).toBe('1');
    clearFlag('x');
    expect(readFlag('x')).toBeNull();
  });
});

describe('sin Web Storage (modo privado o bloqueado)', () => {
  it('las flags no persisten pero no rompen; el viaje de OAuth no arranca', () => {
    const local = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const session = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const blocked = {
      configurable: true,
      get() {
        throw new DOMException('bloqueado', 'SecurityError');
      },
    };
    Object.defineProperty(window, 'localStorage', blocked);
    Object.defineProperty(window, 'sessionStorage', blocked);
    try {
      expect(readFlag('x')).toBeNull();
      writeFlag('x', '1');
      clearFlag('x');
      expect(takeOAuthState()).toBeNull();
      expect(() => {
        startDriveConnect(config, '/restore', () => undefined);
      }).toThrow('no permite guardar');
    } finally {
      if (local) Object.defineProperty(window, 'localStorage', local);
      if (session) Object.defineProperty(window, 'sessionStorage', session);
    }
  });
});
