// API de Recovery simulada para los specs de navegador sin backend (contra `vite preview` del build): intercepta el API
// host del build en todo el contexto, responde con CORS para el origin de la vista previa (con cookies) y registra los
// pedidos con su cuerpo. Lo que no se declara responde 404 (problem+json). Sólo datos públicos y de prueba: la cuenta,
// el step-up ENROLLMENT y el enrollment que la app espera.
import type { BrowserContext, Request } from '@playwright/test';
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
  body: string | null;
  /** Headers del pedido (para comprobar que un secreto no viaja en ninguno). */
  headers: Record<string, string>;
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
    calls.push({ method: request.method(), path, body: request.postData(), headers: await request.allHeaders() });
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

/** Sesión de cuenta, CSRF y la revocación de PlatformSessions al bloquear. */
export function accountRoutes(): MockRoute[] {
  return [
    { method: 'GET', path: /^\/auth\/csrf$/, handle: () => ({ body: { csrfToken: 'csrf-de-prueba' } }) },
    { method: 'GET', path: /^\/users\/me$/, handle: () => ({ body: USER }) },
    { method: 'DELETE', path: /^\/platform-sessions\/[^/]+$/, handle: () => ({ status: 204 }) },
  ];
}

/** Step-up ENROLLMENT para la wallet: el código vence a la hora que diga `codeExpiresAt`; la sesión dura 15 minutos. */
export function enrollmentStepUpRoutes(codeExpiresAt: string): MockRoute[] {
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
              scope: 'ENROLLMENT',
              authMethod: 'STEP_UP',
              walletId: WALLET_ID,
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

/**
 * Lo que informa el backend de un enrollment de R: pendiente o con la R que "recibió". Vence a los 15 minutos, o a la
 * hora fija que se pida (para comprobar el texto del vencimiento).
 */
export function enrollmentView(
  id: string,
  recoveryKey: string | null,
  keyRegistered = recoveryKey !== null,
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(),
) {
  return {
    id,
    walletId: WALLET_ID,
    purpose: 'ONBOARDING',
    status: recoveryKey === null ? 'REQUESTED' : 'SUBMITTED',
    expiresAt,
    enrollmentKeyRegistered: keyRegistered,
    recoveryKey,
    rType: recoveryKey === null ? null : 'INTERNAL',
    submittedAt: recoveryKey === null ? null : new Date().toISOString(),
    confirmedAt: null,
    rejectionReason: null,
  };
}
