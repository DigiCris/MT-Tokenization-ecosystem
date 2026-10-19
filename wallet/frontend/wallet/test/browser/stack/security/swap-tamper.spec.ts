// P18.SEC / P18.T07 contra los servicios reales y el pool real del fork: el par approve + swap que prepara el backend
// se compara con el que arma la app. Un approve por más que el monto exacto (aquí, ilimitado) o un swap con un mínimo
// de salida que no respeta el slippage no se firman, y lo preparado se cancela en el backend (los dos nonces quedan
// libres: el swap sin adulterar se ejecuta enseguida).
import { expect, test, type Page } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem';
import type { PreparedOperation } from '../../../../src/api/wallet-api.ts';
import { swapExecutorV3Abi } from '../../../../src/chain/abis/SwapExecutorV3.ts';
import { fund, tokenBalance, USDC, USDC_HOLDER } from '../helpers/chain.ts';
import { activeWallet, type ActiveWallet } from '../helpers/onboard.ts';
import { contract } from '../helpers/operate.ts';
import { openFromHome, settled, unlockToHome } from '../helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('swap-tamper');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 30_000_000n);
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

const PREPARE = '**/api/v1/wallets/*/swap/prepare';

async function quoteAndPrepare(amount: string): Promise<void> {
  await openFromHome(page, 'Swap');
  await page.getByLabel('Monto').fill(amount);
  await page.getByRole('button', { name: 'Cotizar' }).click();
  await expect(page.locator('[data-quote]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Preparar el swap' }).click();
}

test('approve ilimitado en lugar del monto exacto: no se firma', async () => {
  await page.route(PREPARE, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { operations: PreparedOperation[] };
    const approve = body.operations[0];
    if (approve) {
      approve.safeTx.data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [contract('SwapExecutorV3'), maxUint256],
      });
    }
    await route.fulfill({ response, json: body });
  });
  try {
    await quoteAndPrepare('10');
    await expect(page.getByText(/no coincide con la que armó esta app \(data\)/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /^Firmar/ })).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('swap con un mínimo de salida que no respeta el slippage (1 unidad): no se firma', async () => {
  await page.route(PREPARE, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { operations: PreparedOperation[] };
    const swap = body.operations[1];
    if (swap) {
      const { args } = decodeFunctionData({ abi: swapExecutorV3Abi, data: swap.safeTx.data });
      const [tokenIn, amountIn, , deadline] = args as readonly [Hex, bigint, bigint, bigint];
      swap.safeTx.data = encodeFunctionData({
        abi: swapExecutorV3Abi,
        functionName: 'swap',
        args: [tokenIn, amountIn, 1n, deadline],
      });
    }
    await route.fulfill({ response, json: body });
  });
  try {
    await quoteAndPrepare('10');
    await expect(page.getByText(/no coincide con la que armó esta app \(minAmountOut\)/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: /^Firmar/ })).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('sin adulterar, el mismo swap se firma y se ejecuta enseguida (los nonces se liberaron)', async () => {
  await quoteAndPrepare('10');
  await expect(
    page.getByText(/Permitir que el contrato de swap de la plataforma 0x .* use exactamente 10,00 USDC/),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Firmar las 2 operaciones con tu clave U' }).click();
  await expect(settled(page)).toHaveCount(2, { timeout: 300_000 });
  await expect(page.locator('[data-allowance]')).toHaveAttribute('data-allowance', '0');
  expect(await tokenBalance(USDC, wallet.wallet.safe)).toBe(20_000_000n);
});
