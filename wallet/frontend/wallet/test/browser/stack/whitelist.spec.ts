// P18.T05 contra los servicios reales y el fork: la whitelist leída de la cadena (`destinationsOf`) con los labels del
// backend; alta con la dirección revisada completa, el código del email y la firma de U sobre la SafeTx que arma la app;
// cuenta regresiva de 24 h con la hora de la cadena hasta que el destino se activa; baja firmada por U. Una dirección
// mal escrita no llega a pedir el código.
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { increaseTime } from './helpers/chain.ts';
import { codeFrom, nextMail } from './helpers/mailpit.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { activeDestination, randomAddress } from './helpers/operate.ts';
import { openFromHome, settled, unlockToHome } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let existing: Address;
let added: Address;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('whitelist');
  existing = await activeDestination(wallet, 'Cuenta de Ana');
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

test('lista leída de la cadena con los labels del backend', async () => {
  await openFromHome(page, 'Whitelist');
  const row = page.locator(`li[data-destination="${existing}"]`);
  await expect(row).toHaveAttribute('data-active', 'true', { timeout: 60_000 });
  await expect(row).toContainText('Cuenta de Ana');
  await expect(row).toContainText('Activo');
});

test('una dirección mal escrita no pide el código', async () => {
  const valid = randomAddress();
  // Mayúsculas y minúsculas mezcladas con el checksum EIP-55 roto (una letra cambiada de caja).
  const index = valid.slice(2).search(/[a-fA-F]/) + 2;
  const char = valid.charAt(index);
  const broken = `${valid.slice(0, index)}${char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()}${valid.slice(index + 1)}`;
  await page.getByLabel('Dirección en Base').fill(broken);
  await page.getByLabel('Nombre (para reconocerlo)').fill('Con error');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(page.getByText('La dirección tiene un error de tipeo (el checksum EIP-55 no coincide).')).toBeVisible();
  await page.getByLabel('Dirección en Base').fill('0x1234');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(page.getByText('Escribí una dirección de Base (0x y 40 caracteres).')).toBeVisible();
  await expect(page.getByLabel('Código del email (8 dígitos)')).toHaveCount(0);
});

test('alta: dirección revisada completa, código del email y firma de U; cuenta regresiva de 24 h y activación', async () => {
  added = randomAddress();
  await page.getByLabel('Dirección en Base').fill(added.toLowerCase());
  await page.getByLabel('Nombre (para reconocerlo)').fill('Proveedor');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(page.getByText('Revisá la dirección completa:')).toBeVisible();
  await expect(page.locator(`[data-address="${getAddress(added)}"]`)).toBeVisible();
  const code = codeFrom(
    await nextMail(wallet.email, (m) => m.text.includes(added.slice(2, 6)) && /Código: \d{8}/.test(m.text)),
  );
  await page.getByLabel('Código del email (8 dígitos)').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await expect(page.getByText(/Agregar a tu whitelist el destino/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });

  await openFromHome(page, 'Whitelist');
  const row = page.locator(`li[data-destination="${added}"]`);
  await expect(row).toHaveAttribute('data-active', 'false', { timeout: 60_000 });
  await expect(row).toContainText('Proveedor');
  await expect(row).toContainText(/se activa en (23|24) h \d+ min/);
  await increaseTime(24 * 3600 + 60);
  await openFromHome(page, 'Whitelist');
  await expect(row).toHaveAttribute('data-active', 'true', { timeout: 60_000 });
  await expect(row).toContainText('Activo');
});

test('baja firmada por U: el destino sale de la lista on-chain', async () => {
  const row = page.locator(`li[data-destination="${added}"]`);
  await row.getByRole('button', { name: 'Quitar' }).click();
  await expect(page.getByText(/Quitar de tu whitelist el destino/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await openFromHome(page, 'Whitelist');
  await expect(page.locator(`li[data-destination="${existing}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`li[data-destination="${added}"]`)).toHaveCount(0);
});
