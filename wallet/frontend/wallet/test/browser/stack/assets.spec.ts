// P18.T04 contra los servicios reales y el fork: USDC y USDT con saldo, símbolo, decimales y contrato leídos por el RPC
// del frontend (con link al explorer, sin embeber terceros). Si el contrato on-chain informa otros decimales que los
// fijados en el build (aquí, la respuesta del RPC cambiada en el camino), el error es bloqueante: la app no muestra ni
// opera ese token, tampoco desde el inicio ni desde Enviar.
import { expect, test, type Page, type Route } from '@playwright/test';
import { getAddress } from 'viem';
import { fund, USDC, USDC_HOLDER, USDT, USDT_HOLDER } from './helpers/chain.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { stack } from './helpers/stack.ts';
import { goHome, openFromHome, unlockToHome } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('assets');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 7_500_000n);
  await fund(USDT, USDT_HOLDER, wallet.wallet.safe, 3_250_000n);
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

test('USDC y USDT: saldo, símbolo, decimales y contrato leídos de la cadena, con link al explorer', async () => {
  await openFromHome(page, 'Activos');
  await expect(page.getByRole('heading', { name: 'Activos' })).toBeVisible();
  for (const [symbol, token, balance, text] of [
    ['USDC', USDC, '7500000', '7,50 USDC'],
    ['USDT', USDT, '3250000', '3,25 USDT'],
  ] as const) {
    const article = page.locator(`article[data-token="${symbol}"]`);
    await expect(article.getByRole('heading', { name: symbol })).toBeVisible();
    await expect(article.locator('[data-balance]')).toHaveAttribute('data-balance', balance);
    await expect(article.locator('[data-balance]')).toHaveText(text);
    await expect(article.locator('dt:has-text("Decimales") + dd')).toHaveText('6');
    await expect(article.locator(`[data-address="${getAddress(token)}"]`)).toBeVisible();
    await expect(article.getByRole('link', { name: 'ver en el explorer' })).toHaveAttribute(
      'href',
      `https://basescan.org/address/${getAddress(token)}`,
    );
  }
  // Ningún recurso de terceros: sólo el origen de la app, la API y el RPC del frontend.
  const origins = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).origin),
  );
  const allowed = new Set([
    new URL(page.url()).origin,
    new URL(stack().urls.apiWallet).origin,
    new URL(stack().urls.anvil).origin,
  ]);
  expect(origins.filter((origin) => !allowed.has(origin))).toEqual([]);
});

interface RpcCall {
  id: number;
  method: string;
  params?: [{ to?: string; data?: string }, ...unknown[]];
}

/** El RPC del frontend responde que USDT tiene 18 decimales (`decimals()` = 0x313ce567). */
async function usdtWith18Decimals(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() !== 'POST') return route.continue();
  const payload = request.postDataJSON() as RpcCall | RpcCall[];
  const calls = Array.isArray(payload) ? payload : [payload];
  const isDecimals = (call: RpcCall | undefined) =>
    call?.method === 'eth_call' &&
    call.params?.[0].to?.toLowerCase() === USDT.toLowerCase() &&
    call.params[0].data === '0x313ce567';
  if (!calls.some(isDecimals)) return route.continue();
  const response = await route.fetch();
  const body = (await response.json()) as { id: number; result?: string } | { id: number; result?: string }[];
  const results = Array.isArray(body) ? body : [body];
  for (const result of results) {
    if (isDecimals(calls.find((call) => call.id === result.id))) result.result = `0x${'12'.padStart(64, '0')}`;
  }
  await route.fulfill({ response, json: Array.isArray(body) ? results : results[0] });
}

test('decimales on-chain distintos de los fijados: error bloqueante en Activos, en el inicio y en Enviar', async () => {
  const rpc = new URL(stack().urls.anvil).origin;
  const matcher = (url: URL) => url.origin === rpc;
  await page.route(matcher, usdtWith18Decimals);
  try {
    const blocked = page.getByText(
      `El contrato ${getAddress(USDT)} informa USDT con 18 decimales y esta app lo tiene fijado como USDT con 6: no se opera con ese token.`,
    );
    // El inicio sigue mostrando la Safe (sin saldos) y sus links de operación.
    await openFromHome(page, 'Activos');
    await expect(blocked).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('article[data-token]')).toHaveCount(0);

    await page.getByRole('link', { name: 'MT Wallet, inicio' }).click();
    await expect(blocked).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('ul.balances')).toHaveCount(0);

    await page.getByRole('link', { name: 'Enviar', exact: true }).click();
    await expect(blocked).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Revisar el envío' })).toHaveCount(0);
  } finally {
    // Espera a que termine un handler en vuelo (si no, su fulfill choca con la ruta ya quitada).
    await page.unrouteAll({ behavior: 'wait' });
  }
  await goHome(page);
  await expect(page.locator('ul.balances [data-token="USDT"]')).toHaveAttribute('data-balance', '3250000');
});
