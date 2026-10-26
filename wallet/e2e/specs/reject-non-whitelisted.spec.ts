// P22.T02.m: un destino fuera de la whitelist no recibe nada, por ningún camino. La pantalla de envío ofrece sólo los
// destinos activos de la whitelist, leídos de la cadena, y no tiene un campo libre; un pedido manipulado en la página (el
// destino cambiado por uno fuera de la whitelist) no se firma ni crea una operación; un cliente modificado que firma ese
// pedido con la sesión del usuario recibe el rechazo de la policy de la plataforma (DESTINATION_NOT_WHITELISTED); y un
// intento directo on-chain —la SafeTx de ese envío con la firma de U, sola o junto a la de una clave que no es owner—
// revierte en la Safe. Con la co-firma de S el Guard revierte con DestinationNotWhitelisted: lo prueban los tests del
// contrato y el acceptance de P23 (A18), porque acá no está la clave de S.
import { expect, test, type Page } from '@playwright/test';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ApiError } from '../../frontend/wallet/src/api/problem.ts';
import {
  accountSigner,
  execSovereign,
  fund,
  tokenBalance,
  USDC,
  USDC_HOLDER,
  userSigner,
} from '../fixtures/wallet/chain.ts';
import { activeWallet, type ActiveWallet } from '../fixtures/wallet/onboard.ts';
import { activeDestination, randomAddress, unlockInNode } from '../fixtures/wallet/operate.ts';
import { openFromHome, unlockToHome } from '../fixtures/wallet/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let whitelisted: Address;
let outsider: Address;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('e2e-not-whitelisted');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 50_000_000n);
  whitelisted = await activeDestination(wallet, 'Cuenta habilitada');
  outsider = randomAddress();
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  await (page as Page | undefined)?.close();
});

test('la pantalla de envío ofrece sólo los destinos activos de la whitelist y no tiene un campo libre', async () => {
  await openFromHome(page, 'Enviar');
  const options = page.locator('#send-destination option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('value', whitelisted);
  await expect(page.locator(`#send-destination option[value="${outsider}"]`)).toHaveCount(0);
  await expect(page.locator('input[name="destination"], input#send-destination')).toHaveCount(0);
});

test('un pedido manipulado en la página no se firma ni deja una operación', async () => {
  const before = (await wallet.api.operations(wallet.wallet.id, { limit: 50 })).items.length;
  await page.route('**/wallets/*/send/prepare', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, destination: outsider }) });
  });
  try {
    await page.getByLabel('Monto').fill('1');
    await page.getByRole('button', { name: 'Revisar el envío' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Firmar con tu clave U' })).toHaveCount(0);
  } finally {
    await page.unroute('**/wallets/*/send/prepare');
  }
  expect((await wallet.api.operations(wallet.wallet.id, { limit: 50 })).items.length).toBe(before);
  expect(await tokenBalance(USDC, outsider)).toBe(0n);
});

test('un cliente modificado que firma el pedido con la sesión del usuario recibe el rechazo de la policy', async () => {
  const unlocked = await unlockInNode(wallet);
  try {
    const rejected = await wallet.api
      .prepareSend(unlocked.platform, wallet.wallet.id, { token: 'USDC', destination: outsider, amount: '1000000' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBeInstanceOf(ApiError);
    expect(rejected).toMatchObject({
      status: 422,
      code: 'POLICY_REJECTED',
      problem: { detail: 'DESTINATION_NOT_WHITELISTED' },
    });
  } finally {
    await wallet.api.revokePlatformSession(unlocked.platform.sessionId).catch(() => undefined);
  }
  expect(await tokenBalance(USDC, outsider)).toBe(0n);
});

test('un intento directo on-chain con la firma de U, sola o con una clave que no es owner, revierte', async () => {
  const call = {
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [outsider, 1_000_000n] }),
  };
  const user = userSigner(wallet.userAddress, wallet.userKey);
  const alone = await execSovereign(wallet.wallet.safe, call, [user]);
  expect(alone.status).toBe('reverted');
  const stranger = accountSigner(privateKeyToAccount(generatePrivateKey()));
  const withStranger = await execSovereign(wallet.wallet.safe, call, [user, stranger]);
  expect(withStranger.status).toBe('reverted');
  expect(await tokenBalance(USDC, outsider)).toBe(0n);
  expect(await tokenBalance(USDC, wallet.wallet.safe)).toBe(50_000_000n);
});
