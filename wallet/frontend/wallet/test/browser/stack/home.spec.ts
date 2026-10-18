// P18.T03 contra los servicios reales y el fork: el inicio de una wallet operativa (fondeada con USDC y USDT reales del
// fork, con un envío ya hecho). Dirección de la Safe en EIP-55 que se copia al portapapeles y QR de recepción que se lee
// como esa misma dirección, con la advertencia de red; saldos leídos de la cadena y cruzados con los del backend (si el
// backend informa otro, se avisa y manda el de la cadena); actividad reciente; y el aviso de una rotación pendiente
// leída del timelock on-chain (propuesta por el camino soberano U + R, que la plataforma no inició).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { fund, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from './helpers/chain.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { activeDestination, proposeRecoveryRotationSovereign, sendFromNode } from './helpers/operate.ts';
import { readCanvasQr } from './helpers/qr.ts';
import { goHome, unlockToHome, shownAddress } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let destination: Address;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('home');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 12_340_000n);
  await fund(USDT, USDT_HOLDER, wallet.wallet.safe, 5_000_000n);
  destination = await activeDestination(wallet, 'Cuenta de Bruno');
  await sendFromNode(wallet, destination, 1_000_000n);
  context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  await (context as BrowserContext | undefined)?.close();
});

test('dirección en EIP-55 que se copia, y QR de recepción que se lee como esa dirección, con la advertencia de red', async () => {
  const safe = getAddress(wallet.wallet.safe);
  const shown = page.locator('#safe-title + p');
  await expect(shown.locator(`[data-address="${safe}"]`)).toHaveText(shownAddress(safe));
  await shown.getByRole('button', { name: 'Copiar' }).click();
  await expect(shown.getByRole('button', { name: 'Copiada' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(safe);
  expect(await readCanvasQr(page.getByRole('img', { name: 'QR de la dirección de tu Safe para recibir' }))).toBe(safe);
  await expect(page.getByText('Enviá a esta dirección sólo USDC o USDT en la red Base')).toBeVisible();
});

test('saldos de la cadena; si el backend informa otro, se avisa y manda el de la cadena', async () => {
  const usdc = page.locator('ul.balances [data-token="USDC"]');
  await expect(usdc).toHaveAttribute('data-balance', '11340000');
  await expect(usdc).toContainText('11,34 USDC');
  await expect(page.locator('ul.balances [data-token="USDT"]')).toHaveAttribute('data-balance', '5000000');
  await expect(usdc).not.toContainText('la plataforma informa');

  await page.route('**/api/v1/wallets/*/balances', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { tokens: { symbol: string; balance: string }[] };
    for (const token of body.tokens) if (token.symbol === 'USDC') token.balance = '99000000';
    await route.fulfill({ response, json: body });
  });
  try {
    await goHome(page);
    await expect(usdc).toHaveAttribute('data-balance', '11340000');
    await expect(usdc).toContainText('(la plataforma informa 99,00)');
  } finally {
    await page.unroute('**/api/v1/wallets/*/balances');
  }
});

test('actividad reciente: el envío con su transfer saliente y los transfers entrantes indexados', async () => {
  const recent = page.locator('section[aria-labelledby="recent-title"]');
  await expect
    .poll(
      async () => {
        await goHome(page);
        await expect(recent.getByText('Cargando…')).toHaveCount(0, { timeout: 30_000 });
        return recent.locator('li[data-kind="transfer"]').count();
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2);
  const send = recent.locator('li[data-kind="operation"]').filter({ hasText: 'Envío' }).first();
  await expect(send).toContainText(`enviaste 1,00 USDC a ${shownAddress(destination)}`);
  await expect(recent.getByText(/Recibiste 12,34 USDC/)).toBeVisible();
  await expect(recent.getByText(/Recibiste 5,00 USDT/)).toBeVisible();
  await expect(recent.getByRole('link', { name: 'Ver toda la actividad' })).toBeVisible();
});

test('rotación pendiente leída del timelock on-chain: aviso con la fecha desde la que se puede ejecutar', async () => {
  await expect(page.getByText(/Hay una rotación pendiente/)).toHaveCount(0);
  await proposeRecoveryRotationSovereign(wallet);
  await goHome(page);
  const notice = page.getByText(
    /Hay una rotación pendiente de tu clave de recuperación \(R\): se puede ejecutar desde/,
  );
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await notice.getByRole('link', { name: 'Ver rotaciones' }).click();
  await expect(page.locator('li[data-role="R"]')).toBeVisible({ timeout: 60_000 });
});
