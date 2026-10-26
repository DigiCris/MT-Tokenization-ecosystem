// P22.T02.f y P22.T02.g: el enrollment de R de punta a punta con las dos apps. La Wallet genera el pedido (enlace con el
// secreto `k`); la app Recovery lo abre en otra pestaña (otro dispositivo en la vida real), con la misma cuenta y su
// step-up, y crea R en el navegador (con su Password R y un backup) o conecta una wallet externa (el provider EIP-6963 de
// prueba, que firma la prueba de control con eth_signTypedData_v4); envía la dirección y «Volver a la Wallet» le pasa R
// y `k` a la pestaña del pedido, que la confirma sola. Después la Safe se crea desde la Wallet y queda ACTIVE con esa R
// como recoveryKey en Base.
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { advanceRateLimitWindows } from '../fixtures/stack.ts';
import { installTestWallet } from '../fixtures/test-wallet-provider.ts';
import { safeState } from '../fixtures/recovery/chain.ts';
import { completeStepUp as recoveryStepUp, login as recoveryLogin } from '../fixtures/recovery/ui.ts';
import { onboardUpToRecovery } from '../fixtures/wallet/activation.ts';
import { enrollInRecovery } from '../fixtures/wallet/recovery-app.ts';
import type { Account } from '../fixtures/users.ts';

/** Desde la confirmación de R hasta la Safe operativa, por las pantallas de la Wallet; devuelve la Safe. */
async function createSafe(page: Page, account: Account): Promise<Address> {
  await page.bringToFront();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  await expect(page.locator('[data-expected-safe]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Firmar y crear la Safe' }).click();
  await expect(page.getByRole('heading', { name: 'Tu Safe está operativa' })).toBeVisible({ timeout: 300_000 });
  const { wallet } = await account.api.myWallet();
  expect(wallet?.status).toBe('ACTIVE');
  if (!wallet?.safe) throw new Error('la wallet no tiene Safe');
  return getAddress(wallet.safe);
}

/** «Volver a la Wallet» en Recovery: la pestaña del pedido recibe R y `k` y sigue sola. */
async function backToWallet(recovery: Page): Promise<void> {
  await recovery.getByRole('link', { name: 'Volver a la Wallet' }).click();
  await expect(recovery.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible({ timeout: 60_000 });
  expect(await recovery.evaluate(() => window.location.hash)).toBe('');
}

test('R interna: la Wallet pide, Recovery crea R con su Password R y un backup, y la Safe nace con esa R', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const { account, link, enrollment } = await onboardUpToRecovery(page, 'e2e-enroll-internal');
  advanceRateLimitWindows();
  const recovery = await page.context().newPage();
  try {
    const sent = await enrollInRecovery(recovery, account, link);
    expect(new URLSearchParams(sent.returnLink.hash.slice(1)).get('k')).toBe(enrollment.secret);
    await backToWallet(recovery);
    const safe = await createSafe(page, account);
    const onchain = await safeState(safe);
    expect(onchain.roles.recoveryKey).toBe(sent.recoveryKey);
    expect(onchain.owners).toContain(sent.recoveryKey);
  } finally {
    await recovery.close();
  }
});

test('R externa: Recovery conecta la wallet de prueba, que firma la prueba de control, y la Safe nace con esa R', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const external = privateKeyToAccount(generatePrivateKey());
  const log: string[] = [];
  const { account, link } = await onboardUpToRecovery(page, 'e2e-enroll-external');
  advanceRateLimitWindows();
  const recovery = await page.context().newPage();
  try {
    await installTestWallet(recovery, external, { log });
    await recovery.goto(link.toString());
    await recoveryLogin(recovery, account.email);
    await recoveryStepUp(recovery, account.email);
    await recovery.getByRole('button', { name: 'Usar una wallet externa' }).click();
    await recovery.locator('[data-connector="test.mtw.wallet"]').click();
    await expect(recovery.locator(`[data-address="${external.address}"]`).first()).toBeVisible({ timeout: 60_000 });
    await recovery.getByRole('button', { name: 'Firmar y enviar' }).click();
    await expect(recovery.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible({
      timeout: 60_000,
    });
    expect(log).toContain('eth_signTypedData_v4');
    expect(log.filter((method) => method === 'eth_sign' || method === 'personal_sign')).toEqual([]);
    await backToWallet(recovery);
    const safe = await createSafe(page, account);
    expect((await safeState(safe)).roles.recoveryKey).toBe(external.address);
  } finally {
    await recovery.close();
  }
});
