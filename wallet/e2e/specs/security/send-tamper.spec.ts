// P18.SEC / P18.T06 contra los servicios reales y el fork: ningún dato de la SafeTx se toma del backend sin
// reconstruirla en la app. Si el prepare del envío llega con otros bytes que los que arma la app (otro monto, otro
// contrato o un DELEGATECALL), la firma queda bloqueada y se dice qué campo difiere; sin adulterar, el mismo envío se
// firma y se mina.
import { expect, test, type Page } from '@playwright/test';
import type { Address } from 'viem';
import type { PreparedOperation } from '../../../frontend/wallet/src/api/wallet-api.ts';
import { fund, tokenBalance, USDC, USDC_HOLDER, USDT } from '../../fixtures/wallet/chain.ts';
import { activeWallet, type ActiveWallet } from '../../fixtures/wallet/onboard.ts';
import { activeDestination } from '../../fixtures/wallet/operate.ts';
import { openFromHome, settled, unlockToHome } from '../../fixtures/wallet/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let destination: Address;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('send-tamper');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 10_000_000n);
  destination = await activeDestination(wallet, 'Destino');
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

const PREPARE = '**/api/v1/wallets/*/send/prepare';

const TAMPERED: [string, string, (op: PreparedOperation) => void][] = [
  [
    'otro monto (el último byte del transfer cambiado)',
    'data',
    (op) => {
      op.safeTx.data = `0x${op.safeTx.data.slice(2, -2)}ff`;
    },
  ],
  [
    'otro contrato (USDT en lugar de USDC)',
    'to',
    (op) => {
      op.safeTx.to = USDT;
    },
  ],
  [
    'DELEGATECALL en lugar de CALL',
    'operation',
    (op) => {
      op.safeTx.operation = 1;
    },
  ],
];

for (const [title, field, tamper] of TAMPERED) {
  test(`prepare con ${title}: no se firma`, async () => {
    await page.route(PREPARE, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as PreparedOperation;
      tamper(body);
      await route.fulfill({ response, json: body });
    });
    try {
      await openFromHome(page, 'Enviar');
      await page.getByLabel('Monto').fill('2');
      await page.getByRole('button', { name: 'Revisar el envío' }).click();
      await expect(page.getByText(`no coincide con la que armó esta app (${field}): no se firma.`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Firmar con tu clave U' })).toHaveCount(0);
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('sin adulterar, el mismo envío se firma y se mina', async () => {
  await openFromHome(page, 'Enviar');
  await page.getByLabel('Monto').fill('2');
  await page.getByRole('button', { name: 'Revisar el envío' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  expect(await tokenBalance(USDC, destination)).toBe(2_000_000n);
});
