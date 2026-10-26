// P22.T03: bloqueo por inactividad y sesión vencida, con el reloj de la página controlado (`page.clock`). En la Wallet,
// 5 minutos sin interacción en una pantalla sensible bloquean (con aviso un minuto antes) y la PlatformSession de 15
// minutos vence aunque no haya pantalla sensible; las dos cosas descartan el desbloqueo y la app lo dice al volver a
// desbloquear. En Recovery, 5 minutos sin interacción descartan R y la PlatformSession, con aviso un minuto antes.
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sealRecovery } from '../../fixtures/recovery/envelope.ts';
import { activeWallet as recoveryActiveWallet } from '../../fixtures/recovery/onboard.ts';
import { openFromHome as openRecoveryScreen, throughGate } from '../../fixtures/recovery/ui.ts';
import { recoveryOrigin } from '../../fixtures/stack.ts';
import { activeWallet } from '../../fixtures/wallet/onboard.ts';
import { openFromHome, unlockToHome } from '../../fixtures/wallet/ui.ts';

test('Wallet: 5 minutos sin actividad en una pantalla sensible la bloquean, con aviso un minuto antes', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('e2e-inactivity');
  await page.clock.install();
  await unlockToHome(page, wallet);
  await openFromHome(page, 'Ver toda la actividad');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
  await page.clock.fastForward('04:05');
  await expect(page.locator('[data-inactivity-warning]')).toBeVisible();
  await page.clock.fastForward('01:00');
  await expect(page.getByText('Desbloqueá tu wallet para operar.')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-inactivity-warning]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Desbloquear' }).click();
  await expect(page.getByText('La wallet se bloqueó tras 5 minutos sin actividad.')).toBeVisible();
});

test('Wallet: la PlatformSession de 15 minutos vence y la wallet se bloquea aunque no haya pantalla sensible', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('e2e-expired');
  await page.clock.install();
  await unlockToHome(page, wallet);
  // El inicio no es una pantalla sensible: la inactividad no cuenta, pero la PlatformSession vence igual.
  await page.clock.fastForward('15:30');
  await expect(page.getByText('Desbloqueá tu wallet para operar.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Desbloquear' }).click();
  await expect(page.getByText('La sesión de la wallet venció (15 minutos): desbloqueala de nuevo.')).toBeVisible();
});

test.describe('Recovery', () => {
  // En el E2E el baseURL es el de la Wallet: estos tests navegan la app Recovery.
  test.use({ baseURL: recoveryOrigin() });

  test('5 minutos sin actividad descartan R y la PlatformSession, con aviso un minuto antes', async ({ page }) => {
    test.setTimeout(600_000);
    const key = generatePrivateKey();
    const recovery = privateKeyToAccount(key);
    const wallet = await recoveryActiveWallet('e2e-inactivity-r', recovery);
    const sealed = await sealRecovery(recovery, key, wallet.walletId);
    await page.clock.install();
    await page.goto('/');
    await openRecoveryScreen(page, 'Rotaciones pendientes');
    await throughGate(page, wallet.account.email, sealed);
    await expect(page.getByText('No hay rotaciones pendientes.')).toBeVisible({ timeout: 60_000 });
    await page.clock.fastForward('04:05');
    await expect(page.locator('[data-inactivity-warning]')).toBeVisible();
    await page.clock.fastForward('01:00');
    await expect(page.getByText('Se bloqueó por inactividad: desbloqueá R de nuevo.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No hay rotaciones pendientes.')).toHaveCount(0);
  });
});
