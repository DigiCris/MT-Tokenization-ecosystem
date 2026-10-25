// Google Drive real en los tests de navegador ([F-DRV], P17.TST): el login de Google no se automatiza, así que la
// pantalla de autorización la responde el test con un access token real de la cuenta de prueba (GOOGLE_DRIVE_TEST_*,
// mismo proyecto de Google Cloud que el cliente de Wallet: misma carpeta privada) devuelto por el mismo camino que usa
// Google — redirección al callback con el token y el `state` del pedido en el fragmento. Todo lo demás (subida,
// verificación, lectura, chequeo de salud) va contra la API real de Drive, salvo la revocación: ver answerGoogleConsent.
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { readEnvFile } from '../../../../build/env-file.ts';
import { WALLET_ROOT } from '../../../../build/config.ts';
import { DriveClient } from '../../../../src/drive/client.ts';
import { REVOKE_URL } from '../../../../src/drive/token.ts';

const NAMES = [
  'GOOGLE_DRIVE_TEST_CLIENT_ID',
  'GOOGLE_DRIVE_TEST_CLIENT_SECRET',
  'GOOGLE_DRIVE_TEST_REFRESH_TOKEN',
] as const;
let token: { value: string; expiresAt: number } | null = null;

export async function driveTestToken(): Promise<string> {
  if (token && token.expiresAt - Date.now() > 300_000) return token.value;
  const dotenv = readEnvFile(resolve(WALLET_ROOT, '.env')) ?? {};
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

/**
 * Responde la autorización de Google con el token real (como Google tras el consentimiento). La revocación que hace la
 * app al cerrar sesión ([F-DRV-01]) se intercepta en todo el contexto: el token es de la cuenta de prueba y revocarlo en
 * Google revoca el permiso entero del cliente de prueba para esa cuenta (los refresh tokens de GOOGLE_DRIVE_TEST_* y de
 * EMAIL_TEST_*). El pedido queda en `revoked` y se responde como Google; el formato contra el endpoint real lo prueba
 * test/live/drive.live.test.ts con un token inválido.
 */
export async function answerGoogleConsent(page: Page): Promise<GoogleConsent> {
  const accessToken = await driveTestToken();
  const consent: GoogleConsent = { revoked: [] };
  await page.context().route(`${REVOKE_URL}**`, async (route) => {
    consent.revoked.push(new URLSearchParams(route.request().postData() ?? '').get('token') ?? '');
    const origin = (await route.request().headerValue('origin')) ?? '*';
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': origin }, body: '' });
  });
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

export async function testDrive(): Promise<DriveClient> {
  const accessToken = await driveTestToken();
  return new DriveClient(() => accessToken);
}

/** Borra de la carpeta de la app los `U.enc.json` cuyo contenido es exactamente el de este test. */
export async function removeEnvelopeBackup(content: string): Promise<number> {
  const drive = await testDrive();
  let removed = 0;
  for (const file of await drive.list('U.enc.json')) {
    const stored = new TextDecoder().decode(await drive.download(file.id));
    if (stored === content) {
      await drive.remove(file.id);
      removed++;
    }
  }
  return removed;
}
