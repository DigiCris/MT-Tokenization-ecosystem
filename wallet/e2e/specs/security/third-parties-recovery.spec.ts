// P19.SEC: Recovery no habla con terceros. Con una wallet activa real, R desbloqueada y la PlatformSession RECOVERY, se
// recorren todas las pantallas (inicio, dispositivo, rotaciones, emergencia, recuperación de U, migración, restaurar y
// modo soberano, éstas dos cargadas como documento por la cámara) y cada request y websocket va al propio origin, a la
// API de Recovery o al RPC propio; sin violaciones de CSP ni de Trusted Types. WalletConnect (relay de Reown) sólo
// aparece al elegir ese conector (connectors.spec.ts) y Google Drive sólo al conectarlo (enroll y restore).
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sealRecovery } from '../../fixtures/recovery/envelope.ts';
import { activeWallet } from '../../fixtures/recovery/onboard.ts';
import { recoveryOrigin, stack } from '../../fixtures/stack.ts';
import { openFromHome, throughGate } from '../../fixtures/recovery/ui.ts';
import { recordViolations } from '../../fixtures/recovery/violations.ts';

// En el E2E el baseURL es el de la Wallet: estos tests navegan la app Recovery.
test.use({ baseURL: recoveryOrigin() });

test('todas las pantallas: sólo el propio origin, la API de Recovery y el RPC propio', async ({ page }) => {
  test.setTimeout(600_000);
  const key = generatePrivateKey();
  const recovery = privateKeyToAccount(key);
  const wallet = await activeWallet('third-parties', recovery);
  const sealed = await sealRecovery(recovery, key, wallet.walletId);
  const own = [recoveryOrigin(), new URL(stack().urls.apiRecovery).origin, new URL(stack().urls.anvil).origin];
  const external: string[] = [];
  page.on('request', (request) => {
    const origin = new URL(request.url()).origin;
    if (!own.includes(origin)) external.push(request.url());
  });
  page.on('websocket', (socket) => external.push(socket.url()));
  const violations = await recordViolations(page);

  await page.goto('/');
  await openFromHome(page, 'Rotaciones pendientes');
  await throughGate(page, wallet.account.email, sealed);
  await expect(page.getByText('No hay rotaciones pendientes.')).toBeVisible({ timeout: 60_000 });
  await openFromHome(page, 'Emergencia');
  await expect(page.getByRole('heading', { name: 'Destinos de la whitelist' })).toBeVisible({ timeout: 60_000 });
  await openFromHome(page, 'Recuperar mi clave de usuario (U)');
  await expect(page.getByText('No hay un reemplazo de U pendiente.')).toBeVisible({ timeout: 60_000 });
  await openFromHome(page, 'Migración excepcional');
  await expect(page.getByRole('button', { name: 'Preparar y verificar la migración' })).toBeVisible({
    timeout: 60_000,
  });
  await page.goto('/device-check');
  await expect(page.locator('main')).toContainText(/dispositivo/i);
  expect(await violations()).toEqual([]);

  await page.goto('/restore');
  await page.getByRole('button', { name: 'QR del sobre' }).click();
  await expect(page.getByRole('button', { name: 'Leer el QR con la cámara' })).toBeVisible();
  expect(await violations()).toEqual([]);

  await page.goto('/sovereign');
  await page.getByLabel('Dirección de tu Safe').fill(wallet.safe);
  await page.getByRole('button', { name: 'Leer la Safe en Base' }).click();
  await expect(page.locator(`[data-sovereign-safe="${wallet.safe}"]`)).toBeVisible({ timeout: 60_000 });
  expect(await violations()).toEqual([]);
  expect(external).toEqual([]);
});
