// Aviso de inactividad de la Wallet y cambio de Password U interrumpido ([F-SES-04]; verificación de P17.MAN, N3, N7 y
// N15) contra `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts), un servidor OPAQUE en proceso y el
// reloj de la página simulado: con la wallet desbloqueada y la Password U nueva a la vista, a los 4 minutos sin tocar la
// pantalla sale el aviso, a la vista desde cualquier scroll y sin tapar el final de la página; la rueda o «Seguir usando
// la Wallet» reinician la cuenta, y sin tocar nada la wallet se bloquea y el cambio dice que sigue la Password U anterior
// y qué destruir de la nueva (CHANGE_INTERRUPTED_TEXT).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { serializeEnvelope } from '../../src/crypto/envelope.ts';
import type { Argon2 } from '../../src/crypto/kdf.ts';
import { addressOf, generatePrivateKey } from '../../src/crypto/keys.ts';
import { sealUserKey } from '../../src/onboarding/user-key.ts';
import { CHANGE_INTERRUPTED_TEXT } from '../../src/security/password-u/change.ts';
import { INACTIVITY_WARNING_TEXT, KEEP_USING_LABEL } from '../../src/session/texts.ts';
import { registerOpaque } from '../../src/unlock/opaque.ts';
import { opaqueTestServer } from '../../src/unlock/opaque-server.test-helper.ts';
import { deriveArgon2id } from '../../src/workers/argon2-protocol.ts';
import { accountRoutes, buildConfig, creatingWallet, mockApi, WALLET_ID, type MockRoute } from './helpers/mock-api.ts';

const argon2: Argon2 = (input) => deriveArgon2id(input);
const PASSWORD_U = 'acorn violet marble tundra zebra';

/**
 * Una U de esta wallet sellada con PASSWORD_U, su registro OPAQUE en el servidor de prueba y la API del desbloqueo
 * (como el backend: el registro de la wallet y versión del pedido) y del bloqueo (revocar la PlatformSession).
 */
async function unlockableWallet(): Promise<{ file: string; routes: MockRoute[] }> {
  const server = opaqueTestServer(buildConfig.platformId);
  const key = generatePrivateKey();
  const sealed = await sealUserKey(
    { key, address: addressOf(key) },
    PASSWORD_U,
    { platformId: buildConfig.platformId, walletId: WALLET_ID, keyVersion: 1 },
    argon2,
  );
  const record = await registerOpaque(sealed.authSecret, (registrationRequest) =>
    Promise.resolve({ registrationResponse: server.registrationResponse(WALLET_ID, 1, registrationRequest) }),
  );
  server.records.set(server.identifier(WALLET_ID, 1), record);
  const attempts = new Map<string, (finishLoginRequest: string) => string>();
  const routes: MockRoute[] = [
    {
      method: 'POST',
      path: /^\/platform-sessions\/opaque\/start$/,
      handle: (request) => {
        const { startLoginRequest, walletId } = request.postDataJSON() as {
          startLoginRequest: string;
          walletId: string;
        };
        const started = server.startLogin(walletId, 1, startLoginRequest);
        const loginAttemptId = crypto.randomUUID();
        attempts.set(loginAttemptId, started.finish);
        return {
          body: {
            loginAttemptId,
            loginResponse: started.loginResponse,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
    },
    {
      method: 'POST',
      path: /^\/platform-sessions\/opaque\/finish$/,
      handle: (request) => {
        const { loginAttemptId, finishLoginRequest } = request.postDataJSON() as {
          loginAttemptId: string;
          finishLoginRequest: string;
        };
        attempts.get(loginAttemptId)?.(finishLoginRequest);
        const now = Date.now();
        return {
          body: {
            token: 'platform-session-operations',
            session: {
              id: crypto.randomUUID(),
              scope: 'OPERATIONS',
              authMethod: 'OPAQUE_U',
              walletId: WALLET_ID,
              safe: null,
              issuedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 15 * 60_000).toISOString(),
            },
          },
        };
      },
    },
    { method: 'DELETE', path: /^\/platform-sessions\/[^/]+$/, handle: () => ({ status: 204 }) },
  ];
  return { file: serializeEnvelope(sealed.envelope), routes };
}

/** El aviso entero dentro de la ventana (con la medición del navegador, que no depende del reloj simulado). */
async function expectInView(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('aviso de inactividad a la vista desde cualquier scroll y, si se bloquea, el cambio de Password U dice qué pasó', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const unlockable = await unlockableWallet();
  // Una ventana chica: la Password U nueva no entra y hay que scrollear (como al anotarla en un celular).
  await page.setViewportSize({ width: 390, height: 560 });
  await page.clock.install();
  await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => ({ ...creatingWallet(), status: 'ACTIVE', safe: addressOf(generatePrivateKey()) })),
    ...unlockable.routes,
  ]);

  // Desbloquear desde el cambio de Password U (vuelve a esa pantalla).
  await page.goto('/security/password-u');
  await page.getByRole('link', { name: 'desbloqueá la wallet' }).click();
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(unlockable.file),
  });
  await page.getByLabel('Password U').fill(PASSWORD_U);
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await expect(page.getByRole('button', { name: 'Generar la Password U nueva' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Generar la Password U nueva' }).click();
  const words = page.locator('ol[aria-label="Password U"] .words__word');
  await expect(words).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
  const warning = page.locator('[data-inactivity-warning]');

  // Anotando la Password U nueva sin tocar la pantalla: a los 4 minutos, el aviso.
  await page.clock.fastForward('03:50');
  await expect(warning).toHaveCount(0);
  await page.clock.fastForward('00:10');
  await expect(warning.getByText(INACTIVITY_WARNING_TEXT)).toBeVisible();
  // Fijo abajo y a la vista desde cualquier scroll (N3); al final de la página ocupa su lugar y no tapa el contenido.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await expectInView(page, warning);
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await expectInView(page, warning);
  const main = await page.locator('main').boundingBox();
  const shown = await warning.boundingBox();
  expect((shown?.y ?? 0) + 1).toBeGreaterThanOrEqual((main?.y ?? 0) + (main?.height ?? 0));
  // La rueda es actividad: el aviso se va y la cuenta vuelve a empezar.
  await page.mouse.move(200, 200);
  await page.mouse.wheel(0, -200);
  await expect(warning).toHaveCount(0);
  await page.clock.fastForward('03:50');
  await expect(warning).toHaveCount(0);
  await page.clock.fastForward('00:10');
  await expect(warning).toBeVisible();
  // «Seguir usando la Wallet» también.
  await warning.getByRole('button', { name: KEEP_USING_LABEL }).click();
  await expect(warning).toHaveCount(0);
  await expect(words).toHaveCount(5);

  // Sin tocar nada: el aviso y, al minuto, el bloqueo. La Password U nueva nunca se registró: sigue la anterior, y la
  // pantalla dice qué destruir de la nueva (N7).
  await page.clock.fastForward('04:00');
  await expect(warning).toBeVisible();
  await page.clock.fastForward('01:00');
  await expect(page.getByText(CHANGE_INTERRUPTED_TEXT)).toBeVisible();
  await expect(warning).toHaveCount(0);
  await expect(words).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'desbloqueá la wallet' })).toBeVisible();
});
