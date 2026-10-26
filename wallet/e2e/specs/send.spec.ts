// P18.T06 contra los servicios reales y el fork: envío de USDC y USDT a un destino activo de la whitelist. Sólo se
// pueden elegir destinos activos on-chain (uno recién agregado, todavía en sus 24 h, no aparece); el monto se convierte
// con bigint y los decimales fijados (con errores claros si no se puede, y "1.000" no se toma como 1); el review sale
// de la SafeTx que arma la app y se compara con la del backend; U firma y se sigue el estado hasta minado; un envío de
// alto valor pide el segundo factor por email antes de firmar, y el email muestra el monto y el destino con el mismo
// formato que la app (P18.MAN). Un review cancelado cancela lo preparado en el backend (su nonce queda libre). Un
// prepare adulterado está en security/send-tamper.spec.ts (P18.SEC).
import { expect, test, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { fund, tokenBalance, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from '../fixtures/wallet/chain.ts';
import { codeFrom, nextMail } from '../fixtures/mailpit.ts';
import { activeWallet, type ActiveWallet } from '../fixtures/wallet/onboard.ts';
import { activeDestination, randomAddress } from '../fixtures/wallet/operate.ts';
import { openFromHome, settled, shownAddress, unlockToHome } from '../fixtures/wallet/ui.ts';

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
    ['abc', 'Escribí el monto con números y, si hace falta, una coma para los decimales.'],
    // La app muestra los miles con punto: escrito así, el monto es ambiguo y se pregunta (no se toma "1.000" como 1).
    ['1.000', '¿Quisiste decir 1000? Escribí el monto sin separador de miles'],
    ['1.000,50', '¿Quisiste decir 1000,50? Escribí el monto sin separador de miles'],
    ['0', 'El monto tiene que ser mayor que cero.'],
    ['2000', 'No tenés saldo suficiente de USDC.'],
  ] as const) {
    await page.getByLabel('Monto').fill(amount);
    await page.getByRole('button', { name: 'Revisar el envío' }).click();
    // El error del intento (el mismo texto puede estar también debajo del campo, como lectura de lo escrito).
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  }
});

test('review cancelado: lo preparado se cancela en el backend (libera su nonce) y se vuelve al formulario', async () => {
  await page.getByLabel('Monto').fill('1,5');
  // Debajo del campo, cómo se interpreta lo escrito.
  await expect(page.getByText('Vas a enviar 1,50 USDC.')).toBeVisible();
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 1,50 USDC a «Cuenta de Ana» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar el envío' })).toBeVisible();
  const { items } = await wallet.api.operations(wallet.wallet.id, { limit: 1 });
  expect(items[0]).toMatchObject({ operationType: 'SEND', status: 'CANCELLED' });
});

test('envío de USDC: review desde los bytes propios, firma de U y estado hasta minado', async () => {
  await page.getByLabel('Monto').fill('1,5');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 1,50 USDC a «Cuenta de Ana» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  // Hecho: en pasado, con el hash de la transacción.
  await expect(page.getByText(/^Enviaste 1,50 USDC a «Cuenta de Ana» 0x/)).toBeVisible();
  await expect(page.locator('.review__tx [data-tx]')).toHaveAttribute('data-tx', /^0x[0-9a-f]{64}$/);
  expect(await tokenBalance(USDC, destination)).toBe(1_500_000n);
});

test('envío de USDT con monto con punto decimal', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('USDT', { exact: false }).check();
  await page.getByLabel('Monto').fill('2.25');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await expect(page.getByText(/Enviar 2,25 USDT a «Cuenta de Ana» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDT, destination)).toBe(2_250_000n);
});

test('envío de alto valor: segundo factor por email antes de firmar', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('Monto').fill('1000');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  // El umbral de la policy (ADR-025) y el canal: sin TOTP, el código llega por email con el monto y el destino.
  await expect(page.getByText('Los envíos de 1.000 USDC o más necesitan un segundo factor.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar con tu clave U' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(
    page.getByText(
      /Te mandamos un código por email a .*: antes de escribirlo, comprobá que el email muestre 1\.000,00 USDC y el destino 0x/,
    ),
  ).toBeVisible();
  const mail = await nextMail(wallet.email, (m) => m.subject.includes('alto valor'));
  // Lo que la app pide comparar está en el email con el mismo formato: el monto en es-AR y la dirección agrupada.
  expect(mail.text).toContain('Acción: Envío de 1.000,00 USDC');
  expect(mail.text).toContain(`Destino: ${shownAddress(destination)}`);
  const code = codeFrom(mail);
  await page.getByLabel('Código que te mandamos por email').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDC, destination)).toBe(1_001_500_000n);
});
