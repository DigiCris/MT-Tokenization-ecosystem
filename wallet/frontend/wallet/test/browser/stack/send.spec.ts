// P18.T06 contra los servicios reales y el fork: envío de USDC y USDT a un destino activo de la whitelist. Sólo se
// pueden elegir destinos activos on-chain (uno recién agregado, todavía en sus 24 h, no aparece); el monto se convierte
// con bigint y los decimales fijados (con errores claros si no se puede); el review sale de la SafeTx que arma la app
// y se compara con la del backend; U firma y se sigue el estado hasta minado; un envío de alto valor pide el segundo
// factor por email antes de firmar. Un review cancelado cancela lo preparado en el backend (su nonce queda libre). Un
// prepare adulterado está en security/send-tamper.spec.ts (P18.SEC).
import { expect, test, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { fund, tokenBalance, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from './helpers/chain.ts';
import { codeFrom, nextMail } from './helpers/mailpit.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { activeDestination, randomAddress } from './helpers/operate.ts';
import { openFromHome, settled, unlockToHome } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let destination: Address;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('send');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 1_550_000_000n);
  await fund(USDT, USDT_HOLDER, wallet.wallet.safe, 20_000_000n);
  destination = await activeDestination(wallet, 'Cuenta de Ana');
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

test('sólo destinos activos: uno recién agregado (en sus 24 h) no se puede elegir', async () => {
  const pending = randomAddress();
  await openFromHome(page, 'Whitelist');
  await page.getByLabel('Dirección en Base').fill(pending);
  await page.getByLabel('Nombre (para reconocerlo)').fill('Todavía no');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  const code = codeFrom(
    await nextMail(wallet.email, (m) => m.text.includes(pending.slice(2, 6)) && /Código: \d{8}/.test(m.text)),
  );
  await page.getByLabel('Código del email (8 dígitos)').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });

  await openFromHome(page, 'Enviar');
  const options = page.locator('#send-destination option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('value', destination);
  await expect(options.first()).toContainText('Cuenta de Ana');
});

test('montos: con coma o punto, sin más decimales que el token, mayores que cero y con saldo', async () => {
  for (const [amount, message] of [
    ['1,1234567', 'El token admite hasta 6 decimales.'],
    ['1.000,50', 'Escribí el monto con números y, si hace falta, una coma para los decimales.'],
    ['0', 'El monto tiene que ser mayor que cero.'],
    ['2000', 'No tenés saldo suficiente de USDC.'],
  ] as const) {
    await page.getByLabel('Monto').fill(amount);
    await page.getByRole('button', { name: 'Revisar el envío' }).click();
    await expect(page.getByText(message)).toBeVisible();
  }
});

test('review cancelado: lo preparado se cancela en el backend (libera su nonce) y se vuelve al formulario', async () => {
  await page.getByLabel('Monto').fill('1,5');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 1,50 USDC a 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar el envío' })).toBeVisible();
  const { items } = await wallet.api.operations(wallet.wallet.id, { limit: 1 });
  expect(items[0]).toMatchObject({ operationType: 'SEND', status: 'CANCELLED' });
});

test('envío de USDC: review desde los bytes propios, firma de U y estado hasta minado', async () => {
  await page.getByLabel('Monto').fill('1,5');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 1,50 USDC a 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDC, destination)).toBe(1_500_000n);
});

test('envío de USDT con monto con punto decimal', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('USDT', { exact: false }).check();
  await page.getByLabel('Monto').fill('2.25');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 2,25 USDT a 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDT, destination)).toBe(2_250_000n);
});

test('envío de alto valor: segundo factor por email antes de firmar', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('Monto').fill('1000');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText('Esta operación supera el monto que requiere un segundo factor.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar con tu clave U' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pedir el código' }).click();
  const code = codeFrom(await nextMail(wallet.email, (m) => m.subject.includes('alto valor')));
  await page.getByLabel('Código que te mandamos por email').fill(code);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDC, destination)).toBe(1_001_500_000n);
});
