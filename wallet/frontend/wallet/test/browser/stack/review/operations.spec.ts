// P18.MAN (R-14): recorrido de operación en el fork contra los servicios reales, con capturas de cada pantalla y de cada
// review antes de firmar para el agente revisor (legibilidad del review de operaciones): inicio, activos, alta en la
// whitelist (dirección revisada y SafeTx), envío normal y de alto valor, swap (cotizaciones y las dos SafeTx), actividad
// y las pantallas de Seguridad. Corre en cada navegador de MTW_BROWSERS y sólo con MTW_REVIEW_DIR (capturas en
// <dir>/operations/<navegador>/).
import { expect, test } from '@playwright/test';
import { fund, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from '../helpers/chain.ts';
import { codeFrom, nextMail } from '../helpers/mailpit.ts';
import { activeWallet } from '../helpers/onboard.ts';
import { activeDestination, randomAddress } from '../helpers/operate.ts';
import { openFromHome, openSecurity, settled, unlockToHome } from '../helpers/ui.ts';
import { reviewCamera } from './camera.ts';

test('operación completa en el fork con capturas de cada review', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const snap = reviewCamera(page, 'operations', testInfo.project.name);
  const wallet = await activeWallet('review-operations');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 1_100_000_000n);
  await fund(USDT, USDT_HOLDER, wallet.wallet.safe, 20_000_000n);
  await activeDestination(wallet, 'Cuenta de Ana');
  await unlockToHome(page, wallet);
  await expect(page.getByRole('heading', { name: 'Tu Safe' })).toBeVisible({ timeout: 60_000 });
  await snap('inicio');

  await openFromHome(page, 'Activos');
  await expect(page.getByText('USDC', { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await snap('activos');

  const added = randomAddress();
  await openFromHome(page, 'Whitelist');
  await expect(page.locator('li[data-destination]').first()).toHaveAttribute('data-active', 'true', {
    timeout: 60_000,
  });
  await snap('whitelist');
  await page.getByLabel('Dirección en Base').fill(added.toLowerCase());
  await page.getByLabel('Nombre (para reconocerlo)').fill('Proveedor');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(page.getByText('Revisá la dirección completa:')).toBeVisible();
  await snap('whitelist-revisar-direccion');
  const code = codeFrom(
    await nextMail(wallet.email, (m) => m.text.includes(added.slice(2, 6)) && /Código: \d{8}/.test(m.text)),
  );
  await page.getByLabel('Código del email (8 dígitos)').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await expect(page.getByText(/Agregar a tu whitelist el destino/)).toBeVisible();
  await snap('whitelist-review');
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await snap('whitelist-firmado');

  await openFromHome(page, 'Enviar');
  await expect(page.locator('#send-destination option')).toHaveCount(1);
  await snap('enviar');
  await page.getByLabel('Monto').fill('1,5');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 1,50 USDC a 0x/)).toBeVisible();
  await snap('enviar-review');
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await snap('enviar-minado');

  await openFromHome(page, 'Enviar');
  await page.getByLabel('Monto').fill('1000');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText('Esta operación supera el monto que requiere un segundo factor.')).toBeVisible();
  await snap('enviar-alto-valor');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar el envío' })).toBeVisible();

  await openFromHome(page, 'Swap');
  await page.getByLabel('Monto').fill('20');
  await page.getByRole('button', { name: 'Cotizar' }).click();
  await expect(page.locator('[data-quote]')).toBeVisible({ timeout: 60_000 });
  await snap('swap-cotizacion');
  await page.getByRole('button', { name: 'Preparar el swap' }).click();
  await expect(page.getByText(/Cambiar 20,00 USDC por al menos/)).toBeVisible();
  await snap('swap-review');
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toHaveCount(2, { timeout: 300_000 });
  await snap('swap-minado');

  await openFromHome(page, 'Ver toda la actividad');
  await expect(page.locator('[data-status]').first()).toBeVisible({ timeout: 60_000 });
  await snap('actividad');

  await page.getByRole('link', { name: 'Seguridad', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seguridad', exact: true })).toBeVisible();
  await snap('seguridad');
  await page.getByRole('link', { name: 'Rotaciones (pendientes, cancelar, ejecutar)', exact: true }).click();
  await expect(page.getByText('No hay rotaciones pendientes.')).toBeVisible({ timeout: 60_000 });
  await snap('rotaciones');
  await openSecurity(page, 'Estado y reemplazo de tu clave de recuperación (R)');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await snap('recovery');
});
