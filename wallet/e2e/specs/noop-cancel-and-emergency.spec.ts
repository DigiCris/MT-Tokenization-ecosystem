// P19.T10 contra los servicios reales y el fork: Emergencia en Recovery, el botón de pánico si U está comprometida. Con
// R (sobre desbloqueado) + S: revocar el permiso residual del SwapExecutor sobre USDC, quitar un destino de la whitelist
// leída on-chain, anular una operación sin firmar (se cancela sin NoOp) y anular una firmada que espera un nonce
// anterior: la NoOp del mismo nonce firmada por R ocupa ese nonce y la original nunca se ejecuta. Cada SafeTx la arma
// la app y se compara con la del backend antes de que R firme.
import { expect, test, type Page } from '@playwright/test';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { destinationWhitelistAbi } from '../../frontend/recovery/src/chain/abis/DestinationWhitelist.ts';
import { asSafe, chain, safeState, USDC } from '../fixtures/recovery/chain.ts';
import { sealRecovery, type SealedRecovery } from '../fixtures/recovery/envelope.ts';
import { activeWallet, operationsSession, type ActiveWallet } from '../fixtures/recovery/onboard.ts';
import { operationStatus, prepareRemoval, signAsUser, whitelistBySafe } from '../fixtures/recovery/operate.ts';
import { contract } from '../fixtures/stack.ts';
import { openFromHome, settled, throughGate } from '../fixtures/recovery/ui.ts';
import { recoveryOrigin } from '../fixtures/stack.ts';

// En el E2E el baseURL es el de la Wallet: estos tests navegan la app Recovery.
test.use({ baseURL: recoveryOrigin() });

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let sealed: SealedRecovery;
let page: Page;
const [D1, D2, D3] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address) as [
  Address,
  Address,
  Address,
];

/** El destino sigue en la lista on-chain de la Safe (activo o en activación). */
async function whitelisted(destination: Address): Promise<boolean> {
  const [exists] = await chain().readContract({
    address: contract('DestinationWhitelist'),
    abi: destinationWhitelistAbi,
    functionName: 'destinationInfo',
    args: [wallet.safe, destination],
  });
  return exists;
}

async function reopen(): Promise<void> {
  await openFromHome(page, 'Emergencia');
  await expect(page.getByRole('heading', { name: 'Destinos de la whitelist' })).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const key = generatePrivateKey();
  const recovery = privateKeyToAccount(key);
  wallet = await activeWallet('emergency', recovery);
  sealed = await sealRecovery(recovery, key, wallet.walletId);
  await whitelistBySafe(wallet, [D1, D2, D3]);
  await asSafe(wallet.safe, {
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [contract('SwapExecutorV3'), 2_500_000n],
    }),
  });
  page = await browser.newPage();
  await page.goto('/emergency');
  await throughGate(page, wallet.account.email, sealed);
  await expect(page.getByRole('heading', { name: 'Emergencia', exact: true })).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await (page as Page | undefined)?.close();
});

test('revocar el permiso residual del SwapExecutor sobre USDC', async () => {
  const row = page.locator('[data-allowance="USDC"]');
  await expect(row).toContainText('2500000 unidades');
  await row.getByRole('button', { name: 'Revocar' }).click();
  await expect(page.getByText(/Revocar el permiso de 0x .+ sobre USDC/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(page.getByText('No hay permisos activos.')).toBeVisible({ timeout: 240_000 });
  expect(
    await chain().readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.safe, contract('SwapExecutorV3')],
    }),
  ).toBe(0n);
});

test('quitar un destino de la whitelist leída on-chain', async () => {
  const row = page.locator(`[data-destination="${D3}"]`);
  await row.getByRole('button', { name: 'Quitar' }).click();
  await expect(page.getByText(/Quitar de tu whitelist el destino 0x /)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  // Durante el review la lista no se muestra: vuelve cuando la operación se minó y la pantalla relee la cadena.
  await expect(page.getByRole('heading', { name: 'Destinos de la whitelist' })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator(`[data-destination="${D3}"]`)).toHaveCount(0);
  expect(await whitelisted(D3)).toBe(false);
});

test('anular una operación sin firmar: se cancela sin NoOp y libera su nonce', async () => {
  const session = await operationsSession(wallet);
  const prepared = await prepareRemoval(wallet, session, D1);
  await reopen();
  await page.locator(`[data-operation="${prepared.operationId}"]`).getByRole('button', { name: 'Anular' }).click();
  await expect(
    page.getByText('La operación todavía no estaba firmada: quedó cancelada sin necesidad de una NoOp.'),
  ).toBeVisible();
  expect((await operationStatus(wallet, prepared.operationId)).status).toBe('CANCELLED');
});

test('anular una operación firmada que espera un nonce anterior: la NoOp de R ocupa su nonce', async () => {
  test.setTimeout(600_000);
  const session = await operationsSession(wallet);
  const before = await safeState(wallet.safe);
  const first = await prepareRemoval(wallet, session, D1);
  const second = await prepareRemoval(wallet, session, D2);
  expect(BigInt(second.safeTx.nonce)).toBe(BigInt(first.safeTx.nonce) + 1n);
  await signAsUser(wallet, session, second);
  await reopen();
  const row = page.locator(`[data-operation="${second.operationId}"]`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Anular' }).click();
  await expect(page.getByText(`Cancelar la operación pendiente con nonce ${second.safeTx.nonce} (NoOp)`)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  // La NoOp espera el nonce anterior: U firma la primera y las dos se ejecutan en orden.
  await expect(page.locator('.review__status')).toBeVisible({ timeout: 60_000 });
  await signAsUser(wallet, session, first);
  await expect(settled(page).or(page.getByRole('heading', { name: 'Destinos de la whitelist' }))).toBeVisible({
    timeout: 300_000,
  });
  await expect.poll(async () => (await safeState(wallet.safe)).nonce, { timeout: 120_000 }).toBe(before.nonce + 2n);
  expect(await whitelisted(D1)).toBe(false);
  expect(await whitelisted(D2)).toBe(true);
  await expect
    .poll(async () => (await operationStatus(wallet, second.operationId)).status, { timeout: 120_000 })
    .toBe('CANCELLED');
});
