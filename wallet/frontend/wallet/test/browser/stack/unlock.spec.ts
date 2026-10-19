// P17.T06 [F-SES-02]/[F-SES-04]: desbloqueo contra el backend real con la wallet ACTIVE (onboarding completo por la API,
// P12): sobre + Password U → Argon2id → OPAQUE → PlatformSession OPERATIONS (verificada con un request firmado por la
// session key). Password equivocada: se detecta contra el sobre sin contactar a OPAQUE. Bloqueo manual, por 5 minutos
// de inactividad en una pantalla sensible y al vencer la PlatformSession (reloj de Playwright); al bloquear se revoca
// en el backend.
import { expect, test } from '@playwright/test';
import { serializeEnvelope } from '../../../src/crypto/envelope.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { login, shownAddress, unlockWithFile } from './helpers/ui.ts';

let wallet: ActiveWallet;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  wallet = await activeWallet('unlock');
});

test('desbloquear desde archivo; password equivocada sin OPAQUE; recordar el sobre; bloquear revoca la sesión', async ({
  page,
}) => {
  const opaqueStarts: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/platform-sessions/opaque/start')) opaqueStarts.push(request.url());
  });
  await login(page, wallet.email, wallet.password);
  await expect(page).toHaveURL(/\/unlock$/);
  const json = serializeEnvelope(wallet.envelope);

  await unlockWithFile(page, json, ['palabra', 'que', 'no', 'es', 'esta']);
  await expect(page.getByRole('alert')).toContainText('La Password U no abre este sobre');
  expect(opaqueStarts).toHaveLength(0);

  await page.getByLabel('Password U').fill(wallet.passwordWords.join(' '));
  await page.getByLabel('Recordar el sobre cifrado en este dispositivo').check();
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toContainText(
    shownAddress(wallet.userAddress),
  );
  expect(opaqueStarts).toHaveLength(1);

  const revoked = page.waitForRequest(
    (r) => r.method() === 'DELETE' && /\/platform-sessions\/[0-9a-f-]{36}$/.test(r.url()),
  );
  await page.getByRole('banner').getByRole('button', { name: 'Bloquear' }).click();
  expect((await (await revoked).response())?.status()).toBe(204);
  await page.goto('/unlock');
  await page.getByRole('button', { name: 'Usar el sobre guardado en este dispositivo' }).click();
  await page.getByLabel('Password U').fill(wallet.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();
});

test('se bloquea tras 5 minutos sin actividad en una pantalla sensible', async ({ page }) => {
  await page.clock.install();
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();

  await page.getByRole('link', { name: 'Seguridad' }).click();
  await page.getByRole('link', { name: 'Cambiar la Password U' }).click();
  await expect(page.getByRole('button', { name: 'Generar la Password U nueva' })).toBeVisible();
  await page.clock.fastForward('04:00');
  await expect(page.getByRole('button', { name: 'Generar la Password U nueva' })).toBeVisible();
  await page.clock.fastForward('01:05');
  await expect(page.getByRole('link', { name: 'desbloqueá la wallet' })).toBeVisible();
  await page.getByRole('link', { name: 'desbloqueá la wallet' }).click();
  await expect(page.getByText('La wallet se bloqueó tras 5 minutos sin actividad.')).toBeVisible();
});

test('fuera de las pantallas sensibles no cuenta la inactividad, pero la PlatformSession vence a los 15 minutos', async ({
  page,
}) => {
  await page.clock.install();
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();
  await page.clock.fastForward('10:00');
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();
  await page.clock.fastForward('05:05');
  await expect(page.getByRole('link', { name: 'Desbloquear' })).toBeVisible();
  await page.getByRole('link', { name: 'Desbloquear' }).click();
  await expect(page.getByText('La sesión de la wallet venció (15 minutos)')).toBeVisible();
});
