// API de Wallet simulada para los specs de navegador sin backend (contra `vite preview` del build): intercepta el API
// host del build en todo el contexto (también en otras pestañas), responde con CORS para el origin de la vista previa
// (con cookies) y registra los pedidos con su cuerpo. Lo que no se declara responde 404 (problem+json). Sólo datos
// públicos y de prueba: la cuenta, la wallet en creación, el step-up y los pedidos a Recovery que la app espera.
import type { BrowserContext, Request } from '@playwright/test';
import type { Address } from 'viem';
import { loadBuildConfig } from '../../../build/config.ts';

export const buildConfig = loadBuildConfig();

export interface MockResponse {
  status?: number;
  body?: unknown;
}
export type MockHandler = (request: Request, params: string[]) => MockResponse | Promise<MockResponse>;
export interface MockRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: RegExp;
  handle: MockHandler;
}
export interface ApiCall {
  method: string;
  path: string;
  /** Cuerpo del pedido (null si no tiene). */
  body: string | null;
}

export const USER = {
  id: '6a1f3c2e-9b7d-4e5f-8a1b-2c3d4e5f6a7b',
  email: 'revision@example.test',
  emailVerified: true,
  totpEnabled: false,
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
  createdAt: '2026-10-19T00:00:00Z',
};

export const WALLET_ID = '0b6b3c1e-2f3a-4c5d-8e9f-0a1b2c3d4e5f';

export function creatingWallet() {
  return {
    id: WALLET_ID,
    status: 'CREATING',
    chainId: 8453,
    safe: null,
    createdAt: '2026-10-19T00:00:00Z',
    activatedAt: null,
  };
}

export async function mockApi(context: BrowserContext, origin: string, routes: MockRoute[]): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  const api = buildConfig.apiBaseUrl;
  const base = new URL(api).pathname.replace(/\/+$/, '');
  await context.route(`${api}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
      'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const path = new URL(request.url()).pathname.slice(base.length);
    calls.push({ method: request.method(), path, body: request.postData() });
    for (const { method, path: pattern, handle } of routes) {
      const match = pattern.exec(path);
      if (method !== request.method() || match === null) continue;
      const { status = 200, body = {} } = await handle(request, match.slice(1));
      await route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      return;
    }
    await route.fulfill({
      status: 404,
      headers: cors,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'No encontrado',
        status: 404,
        code: 'NOT_FOUND',
        requestId: 't',
      }),
    });
  });
  return calls;
}

/** Sesión de cuenta con la wallet que diga `wallet()` (null si todavía no hay), CSRF y estado de la plataforma. */
export function accountRoutes(wallet: () => unknown): MockRoute[] {
  return [
    { method: 'GET', path: /^\/auth\/csrf$/, handle: () => ({ body: { csrfToken: 'csrf-de-prueba' } }) },
    { method: 'GET', path: /^\/users\/me$/, handle: () => ({ body: USER }) },
    { method: 'GET', path: /^\/wallets\/me$/, handle: () => ({ body: { wallet: wallet() } }) },
    {
      method: 'GET',
      path: /^\/platform\/status$/,
      handle: () => ({ body: { integrity: 'MONITORED', cooperation: 'ACTIVE', apps: [] } }),
    },
  ];
}

/** Step-up ONBOARDING: el código vence a la hora que diga `codeExpiresAt` y la PlatformSession dura 15 minutos. */
export function onboardingStepUpRoutes(codeExpiresAt: string, walletId: () => string | null): MockRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/start$/,
      handle: () => ({ status: 202, body: { challengeId: crypto.randomUUID(), expiresAt: codeExpiresAt } }),
    },
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/finish$/,
      handle: () => {
        const now = Date.now();
        return {
          body: {
            token: 'platform-session-de-prueba',
            csrfToken: 'csrf-de-prueba-2',
            session: {
              id: crypto.randomUUID(),
              scope: 'ONBOARDING',
              authMethod: 'STEP_UP',
              walletId: walletId(),
              safe: null,
              issuedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 15 * 60_000).toISOString(),
            },
          },
        };
      },
    },
  ];
}

/** Lo que informa el backend de un enrollment de R: pendiente o con la R que "recibió". */
export function enrollmentView(id: string, recoveryKey: Address | null) {
  return {
    id,
    walletId: WALLET_ID,
    purpose: 'ONBOARDING',
    status: recoveryKey === null ? 'REQUESTED' : 'SUBMITTED',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    enrollmentKeyRegistered: recoveryKey !== null,
    recoveryKey,
    rType: recoveryKey === null ? null : 'INTERNAL',
    submittedAt: recoveryKey === null ? null : new Date().toISOString(),
    confirmedAt: null,
    rejectionReason: null,
  };
}
