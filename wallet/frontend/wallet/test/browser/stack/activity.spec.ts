// P18.T08 contra los servicios reales y el fork: la actividad de una Safe con transfers entrantes (fondeo con USDC y
// USDT reales del fork), un envío de la plataforma (la operación muestra el transfer saliente de su transacción), un
// transfer saliente soberano U + R que la plataforma no originó (ítem propio) y una operación cancelada antes de firmar.
// Cada operación con su estado (incluido MINED/CONFIRMED/FINALIZED), los transfers indexados por el backend con su
// contraparte, y sólo links al explorer: la página no carga nada de terceros.
import { expect, test, type Page } from '@playwright/test';
import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import {
  accountSigner,
  execSovereign,
  fund,
  USDC,
  USDC_HOLDER,
  USDT,
  USDT_HOLDER,
  userSigner,
} from './helpers/chain.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { activeDestination, randomAddress, sendFromNode } from './helpers/operate.ts';
import { stack } from './helpers/stack.ts';
import { openFromHome, unlockToHome, shownAddress } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let destination: Address;
let sovereignTo: Address;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('activity');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 8_000_000n);
  await fund(USDT, USDT_HOLDER, wallet.wallet.safe, 4_500_000n);
  destination = await activeDestination(wallet, 'Cuenta de Carla');
  await sendFromNode(wallet, destination, 2_500_000n);
  // Un transfer saliente que la plataforma no originó: U + R por el camino soberano, con un relayer cualquiera.
  sovereignTo = randomAddress();
  const mined = await execSovereign(
    wallet.wallet.safe,
    {
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [sovereignTo, 1_000_000n] }),
    },
    [userSigner(wallet.userAddress, wallet.userKey), accountSigner(wallet.recovery)],
  );
  expect(mined.status).toBe('success');
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

/** Abre la actividad y espera a que cargue la lista (no cuenta mientras dice "Cargando…"). */
async function openActivity(): Promise<void> {
  await openFromHome(page, 'Ver toda la actividad');
  await expect(page.getByRole('heading', { name: 'Actividad' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="activity-title"]').getByText('Cargando…')).toHaveCount(0, {
    timeout: 30_000,
  });
}

test('operaciones con su estado y transfers entrantes y salientes indexados, con su contraparte', async () => {
  const transfers = page.locator('li[data-kind="transfer"]');
  await expect
    .poll(
      async () => {
        await openActivity();
        return transfers.count();
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(3);

  const incoming = page.locator('li[data-kind="transfer"][data-direction="IN"]');
  await expect(incoming.filter({ hasText: 'Recibiste 8,00 USDC' })).toContainText(shownAddress(USDC_HOLDER));
  await expect(incoming.filter({ hasText: 'Recibiste 4,50 USDT' })).toContainText(shownAddress(USDT_HOLDER));
  // El saliente soberano (sin operación de la plataforma) es un ítem propio con su destino.
  const outgoing = page.locator('li[data-kind="transfer"][data-direction="OUT"]');
  await expect(outgoing.filter({ hasText: 'Enviaste 1,00 USDC' })).toContainText(shownAddress(getAddress(sovereignTo)));
  // El envío de la plataforma muestra su transfer saliente (monto y destino reales), sin repetirlo como ítem.
  const send = page.locator('li[data-kind="operation"]').filter({ hasText: 'Envío' });
  await expect(send.first()).toHaveAttribute('data-status', /^(MINED|CONFIRMED|FINALIZED)$/);
  await expect(send.first()).toContainText(`enviaste 2,50 USDC a ${shownAddress(getAddress(destination))}`);
  await expect(outgoing.filter({ hasText: 'Enviaste 2,50 USDC' })).toHaveCount(0);
  await expect(page.locator('li[data-kind="operation"]').filter({ hasText: 'Alta en la whitelist' })).toHaveAttribute(
    'data-status',
    /^(MINED|CONFIRMED|FINALIZED)$/,
  );
});

test('una operación cancelada antes de firmar aparece con su estado y sin transacción', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('Monto').fill('1');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revisar el envío' })).toBeVisible();
  await openActivity();
  const cancelled = page.locator('li[data-kind="operation"][data-status="CANCELLED"]');
  await expect(cancelled.filter({ hasText: 'Envío' })).toHaveCount(1);
  await expect(cancelled.getByRole('link', { name: 'ver transacción' })).toHaveCount(0);
});

test('sólo links al explorer (en una pestaña nueva, sin referrer) y ningún recurso de terceros', async () => {
  for (const link of await page.getByRole('link', { name: 'ver transacción' }).all()) {
    await expect(link).toHaveAttribute('href', /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  expect(await page.getByRole('link', { name: 'ver transacción' }).count()).toBeGreaterThanOrEqual(5);
  const origins = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).origin),
  );
  const allowed = new Set([
    new URL(page.url()).origin,
    new URL(stack().urls.apiWallet).origin,
    new URL(stack().urls.anvil).origin,
  ]);
  expect(origins.filter((origin) => !allowed.has(origin))).toEqual([]);
  await expect(page.locator('iframe, img[src^="http"], script[src^="http"]')).toHaveCount(0);
});
