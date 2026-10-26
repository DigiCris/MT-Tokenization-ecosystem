// P18.T05 contra los servicios reales y el fork: la whitelist leída de la cadena (`destinationsOf`) con los labels del
// backend (entre «»); alta con la dirección revisada completa (contra el email y contra la fuente original, ESC-16), el
// código del email y la firma de U sobre la SafeTx que arma la app; cuenta regresiva de 24 h con la hora de la cadena
// hasta que el destino se activa; baja firmada por U. Una dirección mal escrita o un nombre que imita uno de la app no
// llegan a pedir el código.
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { increaseTime } from '../fixtures/wallet/chain.ts';
import { codeFrom, nextMail } from '../fixtures/mailpit.ts';
import { activeWallet, type ActiveWallet } from '../fixtures/wallet/onboard.ts';
import { activeDestination, randomAddress } from '../fixtures/wallet/operate.ts';
import { goHome, openFromHome, settled, unlockToHome } from '../fixtures/wallet/ui.ts';

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

test('un nombre que imita uno de la app («tu Safe») no pide el código', async () => {
  await page.getByLabel('Dirección en Base').fill(randomAddress());
  await page.getByLabel('Nombre (para reconocerlo)').fill('Tu Safe');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(
    page.getByText('«Tu Safe» es un nombre que la app usa para sus propias direcciones (como «tu Safe»): elegí otro.'),
  ).toBeVisible();
  await expect(page.getByLabel('Código del email (8 dígitos)')).toHaveCount(0);
});

test('alta: dirección revisada completa, código del email y firma de U; cuenta regresiva de 24 h y activación', async () => {
  added = randomAddress();
  await page.getByLabel('Dirección en Base').fill(added.toLowerCase());
  await page.getByLabel('Nombre (para reconocerlo)').fill('Proveedor');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  await expect(
    page.getByText(
      'Antes de escribir el código, compará los 10 grupos de esta dirección con la del email y con la que te pasó ' +
        'el destinatario por otro medio (no la copies de esta pantalla ni del email):',
    ),
  ).toBeVisible();
  await expect(page.locator(`[data-address="${getAddress(added)}"]`)).toBeVisible();
  // El paso del código es otro formulario: su campo arranca vacío (no hereda el nombre recién escrito).
  await expect(page.getByLabel('Código del email (8 dígitos)')).toHaveValue('');
  const code = codeFrom(
    await nextMail(wallet.email, (m) => m.text.includes(added.slice(2, 6)) && /Código: \d{8}/.test(m.text)),
  );
  await page.getByLabel('Código del email (8 dígitos)').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await expect(page.getByText(/Agregar a tu whitelist el destino «Proveedor» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('heading', { name: 'Destino agregado' })).toBeVisible();
  // La pantalla final cuenta lo hecho (no repite lo que había que comparar antes de firmar).
  await expect(page.getByText(/^Agregaste a tu whitelist el destino «Proveedor» 0x/)).toBeVisible();
  await expect(page.getByText(/^El alta ya está en un bloque de Base/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agregar otro destino' })).toBeVisible();

  // Alerta in-app (ADR-006): el inicio avisa del destino que se está activando.
  await goHome(page);
  await expect(page.locator(`[data-activating="${added}"]`)).toContainText('Proveedor', { timeout: 60_000 });
  await page.getByRole('link', { name: 'Whitelist', exact: true }).click();
  const row = page.locator(`li[data-destination="${added}"]`);
  await expect(row).toHaveAttribute('data-active', 'false', { timeout: 60_000 });
  await expect(row).toContainText('Proveedor');
  await expect(row).toContainText(/se activa en (23|24) h \d+ min/);
  await expect(row).toContainText(
    'Si no lo agregaste vos o no es la dirección que esperabas, quitalo antes de que se active.',
  );
  await increaseTime(24 * 3600 + 60);
  await openFromHome(page, 'Whitelist');
  await expect(row).toHaveAttribute('data-active', 'true', { timeout: 60_000 });
  await expect(row).toContainText('Activo');
});

test('baja firmada por U: el destino sale de la lista on-chain', async () => {
  const row = page.locator(`li[data-destination="${added}"]`);
  await row.getByRole('button', { name: 'Quitar' }).click();
  await expect(page.getByText(/Quitar de tu whitelist el destino «Proveedor» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('heading', { name: 'Destino quitado' })).toBeVisible();
  await openFromHome(page, 'Whitelist');
  await expect(page.locator(`li[data-destination="${existing}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`li[data-destination="${added}"]`)).toHaveCount(0);
});

test('un destino nuevo que no agregaste se quita directo desde la alerta del inicio (ESC-16)', async () => {
  const suspicious = randomAddress();
  await openFromHome(page, 'Whitelist');
  await page.getByLabel('Dirección en Base').fill(suspicious);
  await page.getByLabel('Nombre (para reconocerlo)').fill('Sospechoso');
  await page.getByRole('button', { name: 'Pedir el código por email' }).click();
  const code = codeFrom(
    await nextMail(wallet.email, (m) => m.text.includes(suspicious.slice(2, 6)) && /Código: \d{8}/.test(m.text)),
  );
  await page.getByLabel('Código del email (8 dígitos)').fill(code);
  await page.getByRole('button', { name: 'Confirmar el código' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });

  await goHome(page);
  const alert = page.locator(`[data-activating="${suspicious}"]`);
  await expect(alert).toContainText(/Un destino nuevo \(«Sospechoso» 0x .*\) se activa en (23|24) h \d+ min/, {
    timeout: 60_000,
  });
  await expect(alert).toContainText('si no lo agregaste vos o si no es la dirección que esperabas, quitalo');
  await alert.getByRole('link', { name: 'Quitarlo' }).click();
  await expect(page.getByRole('heading', { name: 'Revisá la baja del destino' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Quitar de tu whitelist el destino «Sospechoso» 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await goHome(page);
  await expect(page.locator(`[data-activating="${suspicious}"]`)).toHaveCount(0, { timeout: 60_000 });
});
