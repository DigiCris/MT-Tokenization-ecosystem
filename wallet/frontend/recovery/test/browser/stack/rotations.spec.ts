// P19.T05 contra los servicios reales y el fork: rotaciones pendientes leídas del timelock. La plataforma pide rotar S
// (operador real con la CLI y su TOTP); R —aquí una wallet externa EIP-6963— ve el motivo y la S′ con su atestación
// verificada con la clave fijada en el build y firma la propuesta que arma la app (R + S). R cancela con su firma
// EIP-712 (CancelRotation): por el relay del backend, transmitiendo `cancelWithSignature` con su wallet (paga el gas) o
// exportando la calldata para un relayer cualquiera. Una propuesta madura (48 h) la ejecuta R: S′ queda como owner y
// como S del Guard.
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { fundedAccount, increaseTime, relay, safeState } from './helpers/chain.ts';
import { downloadedText } from './helpers/download.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { addOperator, type StackOperator } from './helpers/operators.ts';
import { activeProposal, backendKnowsProposal, backendSettled } from './helpers/rotations.ts';
import { advanceRateLimitWindows, contract } from './helpers/stack.ts';
import { installTestWallet } from './helpers/test-wallet.ts';
import { openFromHome, settled, throughGateWithWallet } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

const ZERO_ID = /^0x0{64}$/;
let wallet: ActiveWallet;
let operator: StackOperator;
let page: Page;

async function requestRotation(reason: string): Promise<Address> {
  const requested = (await operator.command([
    'executor:rotation-request',
    '--wallet',
    wallet.walletId,
    '--reason',
    reason,
  ])) as { newExecutor: Address };
  return getAddress(requested.newExecutor);
}

/** Pedido de la plataforma → R propone desde la pantalla → la S′ queda en el timelock y el backend la registra. */
async function propose(reason: string, reasonText: RegExp): Promise<Address> {
  // Cada escenario es otro día: las acciones sensibles de Recovery son 3 por día por cuenta ([B-RL]).
  advanceRateLimitWindows();
  const newExecutor = await requestRotation(reason);
  await openFromHome(page, 'Rotaciones pendientes');
  const request = page.locator('[data-s-request]');
  await expect(request).toBeVisible({ timeout: 60_000 });
  await expect(request).toContainText(reasonText);
  await expect(request.locator(`[data-address="${newExecutor}"]`)).toBeVisible();
  await expect(page.getByText('La clave nueva está atestada por el signer de esta versión.')).toBeVisible();
  await page.getByRole('button', { name: 'Revisar y firmar la propuesta' }).click();
  await expect(page.getByText(/Proponer reemplazar la clave de la plataforma \(S\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu wallet' }).click();
  await expect(page.locator('li[data-kind="S"]')).toBeVisible({ timeout: 240_000 });
  await expect.poll(() => activeProposal(wallet.safe, 'S'), { timeout: 60_000 }).not.toMatch(ZERO_ID);
  await backendKnowsProposal(wallet, 'S');
  return newExecutor;
}

async function cancelled(): Promise<void> {
  await expect.poll(() => activeProposal(wallet.safe, 'S'), { timeout: 120_000 }).toMatch(ZERO_ID);
  await backendSettled(wallet, 'S');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const recovery = privateKeyToAccount(generatePrivateKey());
  wallet = await activeWallet('rotations', recovery);
  operator = await addOperator('ops');
  page = await browser.newPage();
  await installTestWallet(page, recovery);
  await page.goto('/rotations');
  await throughGateWithWallet(page, wallet.account.email);
  await expect(page.getByRole('heading', { name: 'Rotaciones pendientes (leídas de Base)' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('No hay rotaciones pendientes.')).toBeVisible();
});

test.afterAll(async () => {
  await (page as Page | undefined)?.close();
});

test('R cancela con su firma EIP-712 por el relay del backend', async () => {
  await propose('MAINTENANCE', /mantenimiento preventivo/);
  await page.locator('li[data-kind="S"]').getByRole('button', { name: 'Cancelar con mi firma' }).click();
  await expect(page.getByText('Cancelación enviada: se confirma con el evento on-chain.')).toBeVisible();
  await cancelled();
});

test('R transmite cancelWithSignature con su wallet (paga el gas)', async () => {
  await propose('SHARD_MIGRATION', /migración de la clave a otro servidor/);
  await page
    .locator('li[data-kind="S"]')
    .getByRole('button', { name: 'Cancelar pagando el gas con mi wallet' })
    .click();
  await expect(page.getByText(/Cancelación transmitida \(0x[0-9a-f]{8}…\)/)).toBeVisible({ timeout: 60_000 });
  await cancelled();
});

test('R exporta la firma de cancelación y un relayer cualquiera la transmite', async () => {
  await propose('HSM_MIGRATION', /módulo de hardware/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('li[data-kind="S"]').getByRole('button', { name: 'Exportar la firma de cancelación' }).click(),
  ]);
  const exported = JSON.parse(await downloadedText(download)) as {
    to: Address;
    data: Hex;
    chainId: number;
  };
  expect(exported.chainId).toBe(8453);
  expect(getAddress(exported.to)).toBe(contract('RotationTimelock'));
  const relayer = await fundedAccount();
  expect((await relay(relayer, { to: exported.to, data: exported.data })).status).toBe('success');
  await cancelled();
});

test('propuesta madura: a las 48 h R la ejecuta y S′ queda como owner y como S del Guard', async () => {
  test.setTimeout(600_000);
  const newExecutor = await propose('KEY_COMPROMISE', /posible compromiso/);
  const row = page.locator('li[data-kind="S"]');
  await expect(row.getByRole('button', { name: 'Ejecutar' })).toHaveCount(0);
  await increaseTime(48 * 3600 + 60);
  await expect(row.getByRole('button', { name: 'Ejecutar' })).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Ejecutar' }).click();
  await expect(page.getByText(/Reemplazar en la Safe la clave 0x .+ por 0x /)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Firmar con tu wallet' }).click();
  await expect(settled(page).or(page.getByText('No hay rotaciones pendientes.'))).toBeVisible({ timeout: 240_000 });
  await expect.poll(async () => (await safeState(wallet.safe)).roles.executor, { timeout: 120_000 }).toBe(newExecutor);
  expect((await safeState(wallet.safe)).owners).toContain(newExecutor);
});
