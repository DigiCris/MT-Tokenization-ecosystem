// Google Drive real en el E2E ([F-DRV], P22.T04): el login de Google no se automatiza, así que la pantalla de
// autorización la responde el test con un access token real de la cuenta de prueba (GOOGLE_DRIVE_TEST_*, mismo proyecto
// de Google Cloud que los clientes de las dos apps: misma carpeta privada) devuelto por el mismo camino que usa Google —
// redirección al callback con el token y el `state` del pedido en el fragmento. Todo lo demás (subida, verificación,
// lectura, chequeo de salud) va contra la API real de Drive, salvo la revocación: ver blockGoogleRevocation. Un solo
// módulo para las dos apps: el bloqueo se instala una vez por contexto aunque el spec use la Wallet y Recovery.
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { readEnvFile } from '../../frontend/wallet/build/env-file.ts';
import { REVOKE_URL } from '../../frontend/wallet/src/drive/token.ts';

const NAMES = [
  'GOOGLE_DRIVE_TEST_CLIENT_ID',
  'GOOGLE_DRIVE_TEST_CLIENT_SECRET',
  'GOOGLE_DRIVE_TEST_REFRESH_TOKEN',
] as const;
let token: { value: string; expiresAt: number } | null = null;

export async function driveTestToken(): Promise<string> {
  if (token && token.expiresAt - Date.now() > 300_000) return token.value;
  const dotenv = readEnvFile(resolve(import.meta.dirname, '../../.env')) ?? {};
  const value = (name: (typeof NAMES)[number]) => process.env[name] || dotenv[name] || '';
  const missing = NAMES.filter((name) => value(name) === '');
  if (missing.length > 0) throw new Error(`faltan ${missing.join(', ')} (tests de Drive real obligatorios)`);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: value('GOOGLE_DRIVE_TEST_CLIENT_ID'),
      client_secret: value('GOOGLE_DRIVE_TEST_CLIENT_SECRET'),
      refresh_token: value('GOOGLE_DRIVE_TEST_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) throw new Error(`token de la cuenta de prueba: ${String(response.status)}`);
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

export interface GoogleConsent {
  /** Tokens que la app pidió revocar en Google (`POST /revoke`), en orden. */
  revoked: string[];
}

const blocked = new WeakMap<BrowserContext, GoogleConsent>();

/**
 * Impide en todo el contexto que un pedido de revocación llegue a Google. El token que reciben estas páginas es de la
 * cuenta de prueba, y revocarlo revoca el permiso entero del cliente de prueba para esa cuenta (los refresh tokens de
 * GOOGLE_DRIVE_TEST_* y de EMAIL_TEST_*); la app lo revoca al cerrar sesión ([F-DRV-01]). Dos capas: un script que corre
 * antes que la app responde ahí mismo, sin red, cualquier `fetch` o `sendBeacon` a /revoke (vale aunque la página se esté
 * cerrando y Playwright ya no intercepte), y la ruta del contexto, por si algo pasara la primera. Cada pedido queda en
 * `revoked`; el formato contra el endpoint real lo prueba test/live/drive.live.test.ts con un token inválido.
 */
export async function blockGoogleRevocation(context: BrowserContext): Promise<GoogleConsent> {
  const existing = blocked.get(context);
  if (existing) return existing;
  const consent: GoogleConsent = { revoked: [] };
  blocked.set(context, consent);
  await context.exposeBinding('mtwRevocationBlocked', (_source, token: string) => {
    consent.revoked.push(token);
  });
  await context.addInitScript((revokeUrl: string) => {
    const report = (body: unknown) => {
      const text = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : '';
      const notify = (window as unknown as { mtwRevocationBlocked?: (token: string) => Promise<void> })
        .mtwRevocationBlocked;
      void notify?.(new URLSearchParams(text).get('token') ?? '').catch(() => undefined);
    };
    const target = (input: RequestInfo | URL) =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!target(input).startsWith(revokeUrl)) return originalFetch(input, init);
      report(init?.body);
      return Promise.resolve(new Response('', { status: 200 }));
    };
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      if (!target(url).startsWith(revokeUrl)) return originalBeacon(url, data);
      report(data);
      return true;
    };
  }, REVOKE_URL);
  await context.route(`${REVOKE_URL}**`, async (route) => {
    consent.revoked.push(new URLSearchParams(route.request().postData() ?? '').get('token') ?? '');
    const origin = (await route.request().headerValue('origin')) ?? '*';
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': origin }, body: '' });
  });
  return consent;
}

/**
 * Responde la autorización de Google con el token real (como Google tras el consentimiento), con la revocación ya
 * bloqueada en el contexto (blockGoogleRevocation): ninguna página recibe el token antes que la protección.
 */
export async function answerGoogleConsent(page: Page): Promise<GoogleConsent> {
  const consent = await blockGoogleRevocation(page.context());
  const accessToken = await driveTestToken();
  await page.route('https://accounts.google.com/**', async (route) => {
    const request = new URL(route.request().url());
    const redirect = new URL(request.searchParams.get('redirect_uri') ?? '');
    const callback = new URL(redirect.pathname, page.url());
    callback.hash = new URLSearchParams({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: '3599',
      scope: request.searchParams.get('scope') ?? '',
      state: request.searchParams.get('state') ?? '',
    }).toString();
    await route.fulfill({ status: 302, headers: { Location: callback.toString() } });
  });
  return consent;
}
