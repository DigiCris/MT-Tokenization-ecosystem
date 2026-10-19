// P19.T07 / P19.MAN (parte inyectada) contra el fork: cada conector de wallet externa de Recovery bajo su CSP y Trusted
// Types —EIP-6963 (una extensión cualquiera y MetaMask presentándose como tal), `injected` (window.ethereum) y
// Coinbase Wallet sólo EOA por su SDK sobre la extensión (wagmi une el anuncio EIP-6963 de Coinbase con ese conector,
// mismo rdns)— conecta en Base y firma con
// eth_signTypedData_v4 la SafeTx que arma la app (nunca eth_sign/personal_sign), sin violaciones de CSP ni de Trusted
// Types y sin requests a terceros. Sin extensiones no se ofrecen los SDKs y listar los conectores no abre conexiones a
// terceros (WalletConnect sólo arranca al elegirlo). El de WalletConnect abre su emparejamiento contra el relay real de
// Reown y muestra el QR propio (sin el modal). Registro y exclusiones: docs/CONNECTORS.md.
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { readCanvasQr } from './helpers/qr.ts';
import { recoveryOrigin, stack } from './helpers/stack.ts';
import { installTestWallet, type TestWalletOptions } from './helpers/test-wallet.ts';
import { recordViolations } from './helpers/violations.ts';

let wallet: ActiveWallet;
let recovery: PrivateKeyAccount;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  recovery = privateKeyToAccount(generatePrivateKey());
  wallet = await activeWallet('connectors', recovery);
});

const OWN_ORIGINS = () => [
  recoveryOrigin(),
  new URL(stack().urls.apiRecovery).origin,
  new URL(stack().urls.anvil).origin,
];

const CONNECTORS: { name: string; connector: string; flavor: NonNullable<TestWalletOptions['flavor']> }[] = [
  { name: 'EIP-6963', connector: 'test.mtw.wallet', flavor: 'generic' },
  { name: 'injected', connector: 'injected', flavor: 'generic' },
  { name: 'MetaMask (extensión, EIP-6963)', connector: 'io.metamask', flavor: 'metamask' },
  { name: 'Coinbase Wallet (SDK sólo EOA con la extensión)', connector: 'coinbaseWalletSDK', flavor: 'coinbase' },
];

for (const { name, connector, flavor } of CONNECTORS) {
  test(`${name}: conecta y firma bajo la CSP y Trusted Types, sin terceros`, async ({ browser }) => {
    const page = await browser.newPage();
    try {
      const violations = await recordViolations(page);
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      const log: string[] = [];
      await installTestWallet(page, recovery, { flavor, log });
      await page.goto('/sovereign');
      await page.getByLabel('Dirección de tu Safe').fill(wallet.safe);
      await page.getByRole('button', { name: 'Leer la Safe en Base' }).click();
      await expect(page.locator(`[data-sovereign-safe="${wallet.safe}"]`)).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Mi clave R es una wallet externa' }).click();
      await page.locator(`[data-connector="${connector}"]`).click();
      await expect(page.getByText('Dirección de tu clave R:')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(`[data-address="${recovery.address}"]`).first()).toBeVisible();
      await page.getByLabel('Acción').selectOption('NOOP');
      await page.getByRole('button', { name: 'Armar la operación' }).click();
      await page.getByRole('button', { name: 'Firmar con tu wallet' }).click();
      await expect(page.locator('[data-sovereign-doc]')).toHaveAttribute('data-roles', 'R', { timeout: 60_000 });
      expect(log).toContain('eth_signTypedData_v4');
      expect(log.filter((m) => m === 'eth_sign' || m === 'personal_sign')).toEqual([]);
      expect(await violations()).toEqual([]);
      const own = OWN_ORIGINS();
      expect(requests.map((url) => new URL(url).origin).filter((origin) => !own.includes(origin))).toEqual([]);
    } finally {
      await page.close();
    }
  });
}

test('sin extensiones: no se ofrecen los SDKs y listar no abre conexiones a terceros', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    const external: string[] = [];
    const own = OWN_ORIGINS();
    page.on('request', (request) => {
      const origin = new URL(request.url()).origin;
      if (!own.includes(origin)) external.push(origin);
    });
    page.on('websocket', (socket) => external.push(new URL(socket.url()).origin));
    await page.goto('/sovereign');
    await page.getByRole('button', { name: 'Mi clave R es una wallet externa' }).click();
    await expect(page.locator('[data-connector="walletConnect"]')).toBeVisible({ timeout: 60_000 });
    const offered = await page
      .locator('[data-connector]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-connector')));
    expect(offered).toEqual(['injected', 'walletConnect']);
    // Unos segundos con la lista a la vista: nada sale hacia terceros (ni el relay de WalletConnect).
    await page.waitForTimeout(3_000);
    expect(external).toEqual([]);
  } finally {
    await page.close();
  }
});

test('WalletConnect: emparejamiento por el relay real de Reown y QR propio, sin violaciones', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    const violations = await recordViolations(page);
    const sockets: string[] = [];
    page.on('websocket', (socket) => sockets.push(new URL(socket.url()).origin));
    await page.goto('/sovereign');
    await page.getByRole('button', { name: 'Mi clave R es una wallet externa' }).click();
    await page.locator('[data-connector="walletConnect"]').click();
    const qr = page.getByRole('img', { name: 'QR de WalletConnect para conectar tu wallet' });
    await expect(qr).toBeVisible({ timeout: 60_000 });
    expect(await readCanvasQr(qr)).toMatch(/^wc:[0-9a-f]{64}@2\?/);
    expect(sockets.some((origin) => /^wss:\/\/relay\.walletconnect\.(org|com)$/.test(origin))).toBe(true);
    expect(await violations()).toEqual([]);
  } finally {
    await page.close();
  }
});
