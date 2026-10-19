// P18.T07 contra los servicios reales y el pool real del fork: la app muestra la cotización del backend y la propia
// (QuoterV2 por el RPC del frontend), arma el par approve exacto + swap y lo compara con el del backend, U firma las dos
// operaciones, se ejecutan en orden y la allowance del SwapExecutor vuelve a 0.
import { expect, test } from '@playwright/test';
import { serializeEnvelope } from '../../../src/crypto/envelope.ts';
import { fund, tokenBalance, USDC, USDC_HOLDER, USDT } from './helpers/chain.ts';
import { activeWallet } from './helpers/onboard.ts';
import { login, unlockWithFile } from './helpers/ui.ts';

test('swap USDC → USDT: cotización propia y del backend, dos operaciones firmadas por U y allowance final 0', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('swap');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 50_000_000n);
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
  await expect(page.getByRole('heading', { name: 'Tu Safe' })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: 'Swap' }).click();
  await page.getByLabel('Monto').fill('20');
  await page.getByRole('button', { name: 'Cotizar' }).click();
  const quote = page.locator('[data-quote]');
  await expect(quote).toBeVisible({ timeout: 60_000 });
  const backendOut = BigInt((await quote.locator('[data-backend-out]').getAttribute('data-backend-out')) ?? '0');
  const ownOut = BigInt((await quote.locator('[data-own-out]').getAttribute('data-own-out')) ?? '0');
  expect(ownOut).toBeGreaterThan(19_000_000n);
  // Las dos cotizaciones son del mismo pool en bloques cercanos: casi iguales.
  expect(backendOut > ownOut ? backendOut - ownOut : ownOut - backendOut).toBeLessThan(ownOut / 1_000n);

  // Una cotización vale para el formulario con el que se pidió: cambiar el monto la descarta.
  await page.getByLabel('Monto').fill('21');
  await expect(quote).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preparar el swap' })).toHaveCount(0);
  await page.getByLabel('Monto').fill('20');
  await page.getByRole('button', { name: 'Cotizar' }).click();
  await expect(quote).toBeVisible({ timeout: 60_000 });
  await expect(quote).toContainText('Mínimo a recibir con 0,3 %');

  const usdtBefore = await tokenBalance(USDT, wallet.wallet.safe);
  await page.getByRole('button', { name: 'Preparar el swap' }).click();
  // El permiso nombra al contrato de swap de la plataforma; el review muestra la cotización y el slippage.
  await expect(
    page.getByText(/Permitir que el contrato de swap de la plataforma 0x .* use exactamente 20,00 USDC/),
  ).toBeVisible();
  await expect(
    page.getByText(/Cambiar 20,00 USDC por al menos .* USDT, que llegan a tu Safe; vence en \d+ min/),
  ).toBeVisible();
  await expect(page.locator('[data-slippage-bps]')).toHaveAttribute('data-slippage-bps', '30');
  await page.getByRole('button', { name: 'Firmar las 2 operaciones con tu clave U' }).click();
  const settled = page.locator('[data-status="MINED"], [data-status="CONFIRMED"], [data-status="FINALIZED"]');
  await expect(settled).toHaveCount(2, { timeout: 300_000 });
  await expect(page.locator('[data-allowance]')).toHaveAttribute('data-allowance', '0');
  expect(await tokenBalance(USDC, wallet.wallet.safe)).toBe(30_000_000n);
  expect((await tokenBalance(USDT, wallet.wallet.safe)) - usdtBefore).toBeGreaterThan(19_900_000n);
});
