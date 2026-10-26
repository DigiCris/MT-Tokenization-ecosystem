// P22.T01: las fixtures del E2E contra el stack real. Las dos vistas previas responden en sus orígenes; una cuenta nueva
// se verifica con el código que llega a Mailpit; el fork adelanta 24 y 48 horas minando los bloques de confirmación y
// fondea con USDC y USDT reales; la wallet externa de prueba se anuncia por EIP-6963 y firma typed data; y ningún pedido
// de revocación a Google sale del navegador (el token de la cuenta de prueba sólo se renueva).
import { expect, test } from '@playwright/test';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { REVOKE_URL } from '../../frontend/wallet/src/drive/token.ts';
import { blockGoogleRevocation, driveTestToken } from '../fixtures/drive.ts';
import {
  chain,
  chainTime,
  CONFIRMATION_BLOCKS,
  fundEth,
  fundUsdc,
  fundUsdt,
  increaseTime,
  tokenBalance,
  USDC,
  USDT,
} from '../fixtures/fork.ts';
import { recoveryOrigin, recoveryUrl, stack, walletOrigin } from '../fixtures/stack.ts';
import { installTestWallet } from '../fixtures/test-wallet-provider.ts';
import { verifiedAccount } from '../fixtures/users.ts';

test('el stack y las vistas previas de las dos apps responden en los orígenes con los que se compilaron', async () => {
  expect(stack().urls.apiWallet).toMatch(/^http:\/\/localhost:\d+\/api\/v1$/);
  for (const origin of [walletOrigin(), recoveryOrigin()]) {
    const response = await fetch(`${origin}/`);
    expect(response.status, origin).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  }
});

test('Mailpit: una cuenta nueva se verifica con el código que mandó el worker', async () => {
  const account = await verifiedAccount('selftest');
  expect(account.user.emailVerified).toBe(true);
});

test('fork: 24 y 48 horas con los bloques de confirmación, y USDC, USDT y ETH reales para una cuenta nueva', async () => {
  const before = await chainTime();
  const block = await chain().getBlockNumber();
  await increaseTime(24 * 3600);
  expect(await chainTime()).toBeGreaterThanOrEqual(before + 24n * 3600n);
  expect(await chain().getBlockNumber()).toBeGreaterThanOrEqual(block + BigInt(CONFIRMATION_BLOCKS));
  await increaseTime(48 * 3600);
  expect(await chainTime()).toBeGreaterThanOrEqual(before + 72n * 3600n);

  const owner = privateKeyToAccount(generatePrivateKey()).address;
  await fundUsdc(owner, 5_000_000n);
  await fundUsdt(owner, 7_000_000n);
  await fundEth(owner);
  expect(await tokenBalance(USDC, owner)).toBe(5_000_000n);
  expect(await tokenBalance(USDT, owner)).toBe(7_000_000n);
  expect(await chain().getBalance({ address: owner })).toBe(10n ** 18n);
});

test('wallet externa de prueba: se anuncia por EIP-6963 y firma typed data con su clave', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey());
  const log: string[] = [];
  await installTestWallet(page, account, { log });
  await page.goto(recoveryUrl('/'));
  const typed = {
    domain: { name: 'MTW selftest', version: '1', chainId: 8453 },
    types: { Mensaje: [{ name: 'texto', type: 'string' }] },
    primaryType: 'Mensaje',
    message: { texto: 'hola' },
  } as const;
  const { announced, accounts, signature } = await page.evaluate(async (data) => {
    const providers: { info: { rdns: string }; provider: { request: (a: object) => Promise<unknown> } }[] = [];
    window.addEventListener('eip6963:announceProvider', (event) => {
      providers.push((event as CustomEvent).detail as (typeof providers)[number]);
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const first = providers[0];
    if (!first) throw new Error('ningún provider se anunció');
    const addresses = (await first.provider.request({ method: 'eth_requestAccounts' })) as string[];
    const signed = (await first.provider.request({
      method: 'eth_signTypedData_v4',
      params: [
        addresses[0],
        JSON.stringify({
          ...data,
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
            ],
            ...data.types,
          },
        }),
      ],
    })) as string;
    return { announced: first.info.rdns, accounts: addresses, signature: signed };
  }, typed);
  expect(announced).toBe('test.mtw.wallet');
  expect(accounts).toEqual([account.address]);
  expect(await recoverTypedDataAddress({ ...typed, signature: signature as Hex })).toBe(account.address);
  expect(log).toEqual(['eth_requestAccounts', 'eth_signTypedData_v4']);
});

test('Drive: ningún pedido de revocación sale del navegador y el token de prueba sólo se renueva', async ({
  page,
  context,
}) => {
  const consent = await blockGoogleRevocation(context);
  const toGoogle: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'oauth2.googleapis.com') toGoogle.push(request.url());
  });
  await page.goto('/');
  const status = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'token-inventado-del-selftest' }),
    });
    navigator.sendBeacon(url, new URLSearchParams({ token: 'otro-token-inventado' }));
    return response.status;
  }, REVOKE_URL);
  expect(status).toBe(200);
  await expect.poll(() => consent.revoked).toEqual(['token-inventado-del-selftest', 'otro-token-inventado']);
  expect(toGoogle).toEqual([]);
  // El token de acceso se pide con el refresh token de la cuenta de prueba (nunca se revoca).
  expect(await driveTestToken()).not.toBe('');
});
