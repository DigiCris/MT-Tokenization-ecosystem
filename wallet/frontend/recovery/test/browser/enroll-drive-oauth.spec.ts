// Revisión de seguridad de ADR-033 (BAJO 3) contra `vite preview`, con la API simulada y Google simulado (intercepción
// de accounts.google.com): el viaje de OAuth del Drive de Recovery desde `/enroll` lleva el secreto k del pedido de la
// Wallet en el estado del viaje (sessionStorage de la pestaña) sólo mientras dura. Completo: al volver por el callback el
// estado se consume, la URL queda limpia, Drive queda conectado y el enlace de regreso sale con el mismo k (que no viaja
// en ningún pedido a la API, ni en sus headers). Abandonado: el estado con k sigue en la pestaña sólo hasta que la app
// vuelve a arrancar fuera del callback, que lo descarta.
//
// El build tiene que tener un cliente OAuth de Recovery (GOOGLE_CLIENT_ID_RECOVERY): sin él no se ofrece Drive.
import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { DRIVE_SCOPE } from '../../src/drive/token.ts';
import {
  accountRoutes,
  buildConfig,
  enrollmentStepUpRoutes,
  enrollmentView,
  mockApi,
  type ApiCall,
} from './helpers/mock-api.ts';

const ENROLLMENT_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const NONCE = `0x${'ef'.repeat(32)}`;
const OAUTH_KEY = 'mtw.recovery.oauth.google';
// Token de prueba sin la forma de un token real de Google (el push protection de GitHub los bloquea).
const TOKEN = ['token', 'de', 'prueba', 'que', 'no', 'sirve', 'para', 'nada'].join('-');

test.skip(buildConfig.googleClientId === null, 'el build no tiene GOOGLE_CLIENT_ID_RECOVERY: Drive no se ofrece');

/** API simulada del enrollment: pendiente hasta que se envía R. */
async function enrollmentApi(context: BrowserContext, origin: string) {
  const state = { submittedR: null as string | null, calls: [] as ApiCall[] };
  state.calls = await mockApi(context, origin, [
    ...accountRoutes(),
    ...enrollmentStepUpRoutes('2030-01-01T15:10:00.000Z'),
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, state.submittedR) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/enrollment-key$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, null, true) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/submit$/,
      handle: (request, [id = '']) => {
        state.submittedR = (request.postDataJSON() as { enrollment: { R: string } }).enrollment.R;
        return { body: enrollmentView(id, state.submittedR) };
      },
    },
  ]);
  return state;
}

/** El estado del viaje de OAuth en el sessionStorage de esta pestaña (null si no hay). */
function oauthState(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.sessionStorage.getItem(key), OAUTH_KEY);
}

test('viaje de OAuth completo desde /enroll: vuelve con el mismo k, la URL limpia y sin estado en la pestaña', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL ?? '').origin;
  const secret = randomBytes(16).toString('base64url');
  const api = await enrollmentApi(context, origin);
  // Google: el consentimiento ya dado vuelve al callback con el token en el fragmento y el mismo state.
  const authorizations: URL[] = [];
  await context.route('https://accounts.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    authorizations.push(url);
    const fragment = new URLSearchParams({
      access_token: TOKEN,
      token_type: 'Bearer',
      expires_in: '3599',
      scope: DRIVE_SCOPE,
      state: url.searchParams.get('state') ?? '',
    });
    await route.fulfill({
      status: 302,
      headers: { location: `${origin}/oauth/google/callback#${fragment.toString()}` },
    });
  });

  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE, k: secret }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  expect(await oauthState(page)).toBeNull();
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page.getByText('Google Drive conectado (carpeta privada de Recovery).')).toBeVisible();
  // A Google sólo le llegó el state (nunca k), y volvió a /enroll sin fragmento ni estado guardado.
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0]?.toString()).not.toContain(secret);
  expect(new URL(page.url()).pathname).toBe('/enroll');
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  expect(await oauthState(page)).toBeNull();

  // El enrollment sigue con el pedido del enlace de ida: el regreso lleva el mismo k.
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await page.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();
  await page.getByRole('button', { name: 'Generar mi clave R' }).click();
  const passwordList = page.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(passwordList).toHaveCount(5);
  const passwordWords = await passwordList.allTextContents();
  await page.getByLabel('Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.').check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(passwordWords[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();
  await expect(page.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  await downloading;
  await page.getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password R al lado).').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible();
  const sent = getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '');
  const returnLink = new URL((await page.locator('[data-return-link]').getAttribute('data-return-link')) ?? '');
  expect(Object.fromEntries(new URLSearchParams(returnLink.hash.slice(1)))).toEqual({
    eid: ENROLLMENT_ID,
    r: sent,
    k: secret,
  });
  // k sólo viajó en los fragmentos y en el estado del viaje: ningún pedido a la API lo lleva (ni en sus headers).
  expect(api.calls.length).toBeGreaterThan(0);
  expect(api.calls.filter((c) => `${c.path} ${c.body ?? ''} ${JSON.stringify(c.headers)}`.includes(secret))).toEqual(
    [],
  );
  expect(await oauthState(page)).toBeNull();
});

test('viaje de OAuth abandonado: el estado con k queda en la pestaña sólo hasta que la app arranca fuera del callback', async ({
  page,
  context,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  const secret = randomBytes(16).toString('base64url');
  await enrollmentApi(context, origin);
  // Google muestra el consentimiento y el usuario no sigue.
  await context.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Google</title>Consentimiento',
    }),
  );
  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE, k: secret }).toString()}`);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);

  // Mientras dura el viaje, el estado (con la ruta de regreso y su k) está en la pestaña: un archivo estático del origin
  // de Recovery, que no arranca la app, lo deja ver.
  await page.goto('/licenses/fonts.txt');
  expect(await oauthState(page)).toContain(secret);
  // La app vuelve a arrancar, pero no por el callback: el viaje quedó abandonado y su estado se descarta.
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await oauthState(page)).toBeNull();

  // Lo mismo si se vuelve a /enroll con el enlace (montar /enroll sin callback también lo descarta).
  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE, k: secret }).toString()}`);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Activar Recovery' }).or(page.getByText(/Este enlace no trae un pedido/)),
  ).toBeVisible();
  expect(await oauthState(page)).toBeNull();
});
