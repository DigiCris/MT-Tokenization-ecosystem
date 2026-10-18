// P18.T10 contra el fork, sin la plataforma: la app Recovery (Node) arma documentos soberanos [W-05] —transfers a una
// dirección cualquiera— y los firma con R. La Wallet, sin sesión de cuenta, importa el documento (archivo JSON o QR
// leído con la cámara simulada de Chromium), abre U en el navegador con el sobre y la Password U, muestra lo que hace la
// SafeTx decodificada de sus bytes y la firma de R que trae, U firma el hash recalculado y exporta el documento (archivo
// y QR animado, que se lee de vuelta cuadro por cuadro); con las dos firmas un relayer cualquiera lo ejecuta.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  concat,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { iSafeAbi } from '../../../src/chain/abis/ISafe.ts';
import { assistedCall, safeTxHash, type SafeTx } from '../../../src/chain/safe-tx.ts';
import { serializeEnvelope } from '../../../src/crypto/envelope.ts';
import { decodeFrames, encodeFrames } from '../../../src/qr/frames.ts';
import { parseSovereignDocument, sovereignContent } from '../../../src/sovereign/document.ts';
import { anvil, chain, fund, receipt, tokenBalance, USDC, USDC_HOLDER } from './helpers/chain.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { randomAddress } from './helpers/operate.ts';
import { readCanvasQr } from './helpers/qr.ts';
import { stack } from './helpers/stack.ts';
import { writeQrVideo } from './helpers/y4m.ts';

const VIDEO = resolve(import.meta.dirname, '../../../test-results/stack/qr-sovereign.y4m');

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

interface Prepared {
  tx: SafeTx;
  hash: Hex;
  destination: Address;
  doc: Record<string, unknown>;
}

let wallet: ActiveWallet;
let fromFile: Prepared;
let fromQr: Prepared;

/** Lo que haría la app Recovery: el documento de un transfer de 1 USDC con el nonce dado, firmado por R. */
async function sovereignTransfer(nonce: bigint): Promise<Prepared> {
  const safe = wallet.wallet.safe;
  const destination = randomAddress();
  const tx = assistedCall(
    USDC,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, 1_000_000n] }),
    nonce,
  );
  const hash = safeTxHash(8453, safe, tx);
  const doc = {
    format: 'mtw-sovereign-safetx',
    version: 1,
    chainId: 8453,
    safe,
    safeTx: {
      ...tx,
      value: '0',
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      nonce: nonce.toString(),
    },
    safeTxHash: hash,
    action: { type: 'SEND', params: { token: USDC, destination, amount: '1000000' } },
    signatures: [{ signer: wallet.recovery.address, role: 'R', signature: await wallet.recovery.sign({ hash }) }],
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return { tx, hash, destination, doc };
}

/** Abre U con el sobre y la Password U, revisa lo decodificado y firma. */
async function openKeyAndSign(page: Page): Promise<void> {
  await expect(page.locator(`[data-address="${wallet.wallet.safe}"]`)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeEnvelope(wallet.envelope)),
  });
  await page.getByLabel('Password U').fill(wallet.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Abrir mi clave U en este navegador' }).click();
  await expect(page.locator('[data-decoded="TRANSFER"]')).toContainText(/Enviar 1,00 USDC a 0x/, { timeout: 60_000 });
  await expect(page.getByText(/Firmas que ya trae: R \(/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(page.getByRole('heading', { name: 'Firma lista' })).toBeVisible();
}

/** Con U + R ejecuta cualquiera (aquí un relayer nuevo); el Guard no aplica la política en el camino soberano. */
async function relay(prepared: Prepared, signatures: { signer: string; signature: Hex }[]): Promise<void> {
  const sorted = [...signatures].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const relayer = privateKeyToAccount(generatePrivateKey());
  await anvil('anvil_setBalance', [relayer.address, `0x${(10n ** 18n).toString(16)}`]);
  const client = createWalletClient({ account: relayer, chain: base, transport: http(stack().urls.anvil) });
  const { tx } = prepared;
  const txHash = await client.writeContract({
    address: wallet.wallet.safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [tx.to, 0n, tx.data, 0, 0n, 0n, 0n, tx.gasToken, tx.refundReceiver, concat(sorted.map((s) => s.signature))],
    gas: 1_500_000n,
  });
  expect((await receipt(txHash)).status).toBe('success');
  expect(await tokenBalance(USDC, prepared.destination)).toBe(1_000_000n);
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  wallet = await activeWallet('sovereign');
  await fund(USDC, USDC_HOLDER, wallet.wallet.safe, 5_000_000n);
  const nonce = await chain().readContract({ address: wallet.wallet.safe, abi: iSafeAbi, functionName: 'nonce' });
  // El del archivo se ejecuta primero (nonce N); el del QR va con N + 1. El video existe antes de abrir el navegador.
  fromFile = await sovereignTransfer(nonce);
  fromQr = await sovereignTransfer(nonce + 1n);
  mkdirSync(dirname(VIDEO), { recursive: true });
  writeQrVideo(VIDEO, await encodeFrames(sovereignContent(parseSovereignDocument(JSON.stringify(fromQr.doc)))));
});

test('documento por archivo: R firmó en Recovery, U firma en Wallet sin la plataforma y un relayer ejecuta', async ({
  page,
}) => {
  // Sin login: la salida soberana no depende de la cuenta ni del backend.
  await page.goto('/sovereign');
  await page.getByLabel('Documento de la operación (archivo JSON)').setInputFiles({
    name: 'mtw-sovereign.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fromFile.doc)),
  });
  await openKeyAndSign(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el documento firmado' }).click();
  const signed = JSON.parse(readFileSync(await (await downloading).path(), 'utf8')) as {
    signatures: { signer: string; role: string; signature: Hex }[];
  };
  const userSignature = signed.signatures.find((s) => s.role === 'U');
  expect(getAddress(await recoverAddress({ hash: fromFile.hash, signature: userSignature?.signature ?? '0x' }))).toBe(
    getAddress(wallet.userAddress),
  );
  await relay(fromFile, signed.signatures);
});

test('documento por QR con la cámara: U firma y el QR animado que exporta la app se lee como el documento firmado', async ({
  page,
}) => {
  await page.goto('/sovereign');
  await page.getByRole('button', { name: 'Leer el QR con la cámara' }).click();
  await openKeyAndSign(page);

  // Los cuadros MTWQR1 del QR animado, leídos de los píxeles a medida que la app los rota.
  const frames = new Map<string, string>();
  let total = 0;
  const canvas = page.getByRole('img', { name: /^QR del documento firmado, cuadro \d+ de \d+$/ });
  await expect
    .poll(
      async () => {
        const text = await readCanvasQr(canvas);
        const match = /^MTWQR1:(\d+)\/(\d+):/.exec(text);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          total = Number(match[2]);
          frames.set(match[1], text);
        }
        return total > 0 && frames.size === total;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  const signed = parseSovereignDocument(await decodeFrames([...frames.values()]));
  expect(signed.safeTxHash).toBe(fromQr.hash);
  const userSignature = signed.signatures.find((s) => s.role === 'U');
  expect(getAddress(await recoverAddress({ hash: fromQr.hash, signature: userSignature?.signature ?? '0x' }))).toBe(
    getAddress(wallet.userAddress),
  );
  await relay(fromQr, signed.signatures);
});
