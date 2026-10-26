// «Perdí mi Password U» (P17.T07) contra `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts) y un
// servidor OPAQUE en proceso: step-up U_REPLACEMENT, U' con su Password U' y un backup, registro y la pantalla final.
// Ésta muestra la dirección de U' que generó esta app (la del sobre, nunca la que informa la plataforma), agrupada como
// en las apps, con qué hacer en Recovery (copiar sus 10 grupos y no firmar si Recovery muestra otra), y el enlace y el
// QR con esa misma U'. Si la plataforma informa otra U', no se sigue a Recovery y esa dirección no aparece.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { parseEnvelope } from '../../src/crypto/envelope.ts';
import { addressOf, generatePrivateKey } from '../../src/crypto/keys.ts';
import { addressGroups } from '../../src/recovery-activation/activation.ts';
import { NEW_USER_KEY_COMPARE_TEXT, OTHER_USER_KEY_TEXT } from '../../src/security/password-u/lost.ts';
import { opaqueTestServer } from '../../src/unlock/opaque-server.test-helper.ts';
import { accountRoutes, creatingWallet, mockApi, WALLET_ID } from './helpers/mock-api.ts';
import { downloadedText } from './stack/helpers/download.ts';

const ROTATION_ID = 'f0e1d2c3-b4a5-4968-8776-655443322110';

/** API simulada: wallet activa, step-up U_REPLACEMENT, registro OPAQUE de U' y alta de U' (con la U' que diga `reported`). */
async function lostPasswordApi(
  context: BrowserContext,
  baseURL: string | undefined,
  reported: (requested: string) => string,
): Promise<{ registered: string[] }> {
  const server = opaqueTestServer();
  const state = { registered: [] as string[] };
  await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => ({ ...creatingWallet(), status: 'ACTIVE', safe: addressOf(generatePrivateKey()) })),
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/start$/,
      handle: () => ({
        status: 202,
        body: { challengeId: crypto.randomUUID(), expiresAt: '2030-01-01T15:10:00.000Z' },
      }),
    },
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/finish$/,
      handle: () => {
        const now = Date.now();
        return {
          body: {
            token: 'platform-session-u-replacement',
            csrfToken: 'csrf-de-prueba-2',
            session: {
              id: crypto.randomUUID(),
              scope: 'U_REPLACEMENT',
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
    {
      method: 'POST',
      path: /^\/wallets\/[^/]+\/user-key\/opaque-registration$/,
      handle: (request) => {
        const { registrationRequest } = request.postDataJSON() as { registrationRequest: string };
        return {
          body: { registrationResponse: server.registrationResponse(WALLET_ID, 2, registrationRequest), keyVersion: 2 },
        };
      },
    },
    {
      method: 'POST',
      path: /^\/recovery\/u-replacement$/,
      handle: (request) => {
        const { userKey } = request.postDataJSON() as { userKey: string };
        state.registered.push(userKey);
        return {
          status: 201,
          body: {
            rotationId: ROTATION_ID,
            walletId: WALLET_ID,
            userKey: reported(userKey),
            keyVersion: 2,
            status: 'DRAFT',
          },
        };
      },
    },
  ]);
  return state;
}

/** Desde la pantalla de inicio de «Perdí mi Password U» hasta registrar U' con el archivo cifrado; devuelve su sobre. */
async function registerNewUserKey(page: Page): Promise<ReturnType<typeof parseEnvelope>> {
  await page.goto('/security/lost-password-u');
  await page.getByRole('button', { name: 'Empezar' }).click();
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  const shown = page.locator('ol[aria-label="Password U"] .words__word');
  await expect(shown).toHaveCount(5, { timeout: 30_000 });
  const words = await shown.allTextContents();
  await page.getByLabel(/Anoté las 5 palabras/).check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(words[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  const downloading = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click({ timeout: 60_000 });
  const envelope = parseEnvelope(JSON.parse(await downloadedText(await downloading)));
  await page.getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password U al lado).').check();
  await page.getByRole('button', { name: 'Registrar la clave nueva' }).click();
  return envelope;
}

test("pantalla final: la dirección de U' que generó esta app, para copiarla en Recovery, y el enlace con esa U'", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const api = await lostPasswordApi(context, baseURL, (requested) => requested);
  const envelope = await registerNewUserKey(page);
  const newKey = envelope.keyAddress;
  // El registro (OPAQUE y el alta de U') termina después del clic: se espera a que llegue.
  await expect.poll(() => api.registered).toEqual([newKey]);

  await expect(page.getByRole('heading', { name: 'Seguí en la app Recovery' })).toBeVisible();
  const shown = page.locator(`[data-new-user-key="${newKey}"]`);
  await expect(shown.getByRole('heading', { name: 'Dirección de tu clave U nueva' })).toBeVisible();
  // Agrupada como en las apps: «0x» y los 10 grupos de 4 que se copian en Recovery.
  const grouped = `0x ${addressGroups(newKey).join(' ')}`;
  expect(grouped).toMatch(/^0x( [0-9A-Fa-f]{4}){10}$/);
  await expect(shown.locator(`[data-address="${newKey}"]`)).toHaveText(grouped);
  await expect(shown.getByText(NEW_USER_KEY_COMPARE_TEXT)).toBeVisible();
  // El enlace y el QR llevan la rotación y esa misma U'.
  const handoff = new URL((await page.getByTestId('recovery-handoff').getAttribute('href')) ?? '');
  expect(handoff.pathname).toBe('/recover-u');
  expect(Object.fromEntries(new URLSearchParams(handoff.hash.slice(1)))).toEqual({ rid: ROTATION_ID, u: newKey });
  await expect(page.getByRole('img', { name: 'QR para continuar en Recovery' })).toBeVisible();
});

test("si la plataforma informa otra U', no se sigue a Recovery y esa dirección no aparece", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const substituted: Address = addressOf(generatePrivateKey());
  await lostPasswordApi(context, baseURL, () => substituted);
  await registerNewUserKey(page);
  await expect(page.getByText(OTHER_USER_KEY_TEXT)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seguí en la app Recovery' })).toHaveCount(0);
  await expect(page.getByTestId('recovery-handoff')).toHaveCount(0);
  const html = (await page.content()).toLowerCase();
  expect(html).not.toContain(substituted.slice(2).toLowerCase());
});
