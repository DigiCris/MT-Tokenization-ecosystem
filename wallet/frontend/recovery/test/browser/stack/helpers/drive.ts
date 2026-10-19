// Google Drive real en los tests de navegador de Recovery ([F-DRV]): el login de Google no se automatiza, así que la
// pantalla de autorización la responde el test con un access token real de la cuenta de prueba (GOOGLE_DRIVE_TEST_*)
// devuelto por el mismo camino que usa Google —redirección al callback con el token y el `state` del pedido en el
// fragmento—. Todo lo demás (subida verificada, listado y lectura de los sobres) va contra la API real de Drive.
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { WALLET_ROOT } from '../../../../build/config.ts';
import { readEnvFile } from '../../../../build/env-file.ts';
import { DriveClient } from '../../../../src/drive/client.ts';

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

/** Responde la autorización de Google con el token real (como Google tras el consentimiento). */
export async function answerGoogleConsent(page: Page): Promise<void> {
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
}

export async function testDrive(): Promise<DriveClient> {
  const accessToken = await driveTestToken();
  return new DriveClient(() => accessToken);
}

/** Borra el backup de R de una wallet de este test (nombre propio por wallet: no toca el de otras corridas). */
export async function removeRecoveryBackup(walletId: string): Promise<void> {
  const drive = await testDrive();
  for (const file of await drive.list(`R.enc.${walletId}.json`)) await drive.remove(file.id);
}
