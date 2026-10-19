// P19.T06 contra el fork con la plataforma apagada (API de Wallet y de Recovery, worker y gas tank detenidos): Recovery
// lee la Safe por su RPC, arma la SafeTx tipada con el nonce on-chain y R (sobre desbloqueado con la Password R) la
// firma; el documento [W-05] se exporta, U lo co-firma (aquí en Node, como lo haría la app Wallet sin la plataforma) y
// vuelve por archivo o por QR (cámara simulada). Con las dos firmas, la calldata de execTransaction la transmite un
// relayer cualquiera o una wallet externa que paga el gas. Ninguna parte depende del backend.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFrames } from '../../../src/qr/frames.ts';
import { canonicalize, type Json } from '../../../src/api/jcs.ts';
import { fund, fundedAccount, relay, safeState, tokenBalance, USDC, USDC_HOLDER } from './helpers/chain.ts';
import { downloadedText } from './helpers/download.ts';
import { sealRecovery, type SealedRecovery } from './helpers/envelope.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { writeQrVideo } from './helpers/qr.ts';
import { stack, startBackend, stopBackend } from './helpers/stack.ts';
import { installTestWallet } from './helpers/test-wallet.ts';
import { unlockFromFile } from './helpers/ui.ts';

const VIDEO = resolve(import.meta.dirname, '../../../test-results/stack/qr-sovereign.y4m');
const OUT = resolve(import.meta.dirname, '../../../test-results/stack');

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  },
});
test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let sealed: SealedRecovery;
let page: Page;
const AMOUNT = 1_250_000n;

interface Doc {
  safe: Address;
  safeTxHash: Hex;
  signatures: { signer: Address; role: 'U' | 'R'; signature: Hex }[];
  [key: string]: unknown;
}

/** U co-firma el documento exportado por Recovery (lo que haría la app Wallet sin la plataforma). */
async function userSigns(doc: Doc): Promise<Doc> {
  const signature = await wallet.user.account.sign({ hash: doc.safeTxHash });
  return { ...doc, signatures: [...doc.signatures, { signer: wallet.user.account.address, role: 'U', signature }] };
}

async function exportedDocument(card: ReturnType<Page['locator']>): Promise<Doc> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: 'Descargar el documento' }).click(),
  ]);
  return JSON.parse(await downloadedText(download)) as Doc;
}

async function backendDown(): Promise<boolean> {
  try {
    await fetch(`${stack().urls.apiRecovery}/health/ready`, { signal: AbortSignal.timeout(3_000) });
    return false;
  } catch {
    return true;
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const key = generatePrivateKey();
  const recovery = privateKeyToAccount(key);
  wallet = await activeWallet('sovereign', recovery);
  sealed = await sealRecovery(recovery, key, wallet.walletId);
  await fund(USDC, USDC_HOLDER, wallet.safe, AMOUNT);
  mkdirSync(dirname(VIDEO), { recursive: true });
  stopBackend();
  expect(await backendDown()).toBe(true);
  page = await browser.newPage();
  await installTestWallet(page, await fundedAccount());
});

test.afterAll(async () => {
  await (page as Page | undefined)?.close();
  // Los specs siguientes necesitan la plataforma.
  startBackend();
});

test('con la plataforma apagada: R firma la transferencia, U co-firma por archivo y un relayer la ejecuta', async () => {
  test.setTimeout(600_000);
  await page.goto('/sovereign');
  await page.getByLabel('Dirección de tu Safe').fill(wallet.safe.toLowerCase());
  await page.getByRole('button', { name: 'Leer la Safe en Base' }).click();
  const read = page.locator(`[data-sovereign-safe="${wallet.safe}"]`);
  await expect(read).toBeVisible({ timeout: 60_000 });
  await expect(read.locator(`[data-address="${wallet.user.account.address}"]`)).toBeVisible();
  await unlockFromFile(page, sealed);
  await expect(page.getByText(`Clave R:`)).toBeVisible({ timeout: 120_000 });

  const destination = privateKeyToAccount(generatePrivateKey()).address;
  await page.getByLabel('Acción').selectOption('TRANSFER');
  await page.getByLabel('Token').selectOption('USDC');
  await page.getByLabel('Dirección de destino en Base').fill(destination);
  await page.getByRole('button', { name: 'Armar la operación' }).click();
  await expect(page.locator('[data-draft="TRANSFER"]')).toContainText(/Enviar 1,25 USDC a 0x /);
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  const card = page.locator('[data-sovereign-doc]');
  await expect(card).toHaveAttribute('data-roles', 'R');
  await expect(card).toContainText('Falta la firma de U');

  const doc = await exportedDocument(card);
  expect(doc.signatures.map((s) => s.role)).toEqual(['R']);
  const file = join(OUT, `sovereign-transfer-${doc.safeTxHash.slice(2, 10)}.json`);
  writeFileSync(file, JSON.stringify(await userSigns(doc), null, 2));
  await page.getByLabel('Documento (archivo JSON)').setInputFiles(file);
  const signed = page.locator(`[data-sovereign-doc="${doc.safeTxHash}"]`);
  await expect(signed).toHaveAttribute('data-roles', 'RU');
  await expect(signed).toContainText('Tiene las firmas de U y R: se puede ejecutar.');

  const [calldata] = await Promise.all([
    page.waitForEvent('download'),
    signed.getByRole('button', { name: 'Exportar la calldata para un relayer' }).click(),
  ]);
  const exported = JSON.parse(await downloadedText(calldata)) as {
    to: Address;
    data: Hex;
    chainId: number;
  };
  expect(exported.chainId).toBe(8453);
  expect(getAddress(exported.to)).toBe(wallet.safe);
  const relayer = await fundedAccount();
  expect((await relay(relayer, exported)).status).toBe('success');
  expect(await tokenBalance(USDC, destination)).toBe(AMOUNT);
  expect(await tokenBalance(USDC, wallet.safe)).toBe(0n);
  expect(await backendDown()).toBe(true);
});

test('con la plataforma apagada: NoOp, la firma de U vuelve por QR y una wallet externa paga el gas', async () => {
  test.setTimeout(600_000);
  const before = await safeState(wallet.safe);
  await page.getByRole('button', { name: 'Leer la Safe en Base' }).click();
  await expect(page.locator(`[data-nonce="${before.nonce.toString()}"]`)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Acción').selectOption('NOOP');
  await expect(page.getByLabel('Nonce de la operación a anular')).toHaveValue(before.nonce.toString());
  await page.getByRole('button', { name: 'Armar la operación' }).click();
  await expect(page.locator('[data-draft="NOOP"]')).toContainText(
    `Cancelar la operación pendiente con nonce ${before.nonce.toString()} (NoOp)`,
  );
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  const card = page.locator('[data-sovereign-doc][data-roles="R"]');
  const doc = await exportedDocument(card);
  const content = canonicalize((await userSigns(doc)) as unknown as Json);
  writeQrVideo(VIDEO, await encodeFrames(content));
  await page.getByRole('button', { name: 'Leer el QR del documento con la cámara' }).click();
  const signed = page.locator(`[data-sovereign-doc="${doc.safeTxHash}"]`);
  await expect(signed).toHaveAttribute('data-roles', 'RU', { timeout: 60_000 });

  await page.getByRole('button', { name: 'Conectar una wallet para pagar el gas' }).click();
  await page.locator('[data-connector="test.mtw.wallet"]').click();
  await signed.getByRole('button', { name: 'Transmitir con MTW Test Wallet' }).click();
  await expect(signed.getByText(/Ejecutada en el bloque \d+/)).toBeVisible({ timeout: 120_000 });
  expect((await safeState(wallet.safe)).nonce).toBe(before.nonce + 1n);
  expect(await backendDown()).toBe(true);
});
