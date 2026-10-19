// P19.T09: salida soberana de punta a punta en el fork con la plataforma y los frontends apagados. Una Safe de la
// WalletFactory con U y R de los vectores (y una S cualquiera) y USDC real del fork; la herramienta, abierta desde el
// disco, abre U con su sobre y su Password y R con sus 17 palabras, arma la transferencia de todo el saldo con el nonce
// on-chain, la firma con las dos, y la transmite con otra cuenta que paga el gas. Los fondos llegan al destino.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { base } from 'viem/chains';

const ROOT = resolve(import.meta.dirname, '../..');
const VECTORS = resolve(ROOT, '../../contracts/test/vectors');
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_HOLDER: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const AMOUNT = 25_000_000n;
const FACTORY_ABI = parseAbi([
  'function createWallet(address userKey, address recoveryKey, address executor, uint256 saltNonce) returns (address)',
  'function predictWalletAddress(address userKey, address recoveryKey, address executor, uint256 saltNonce) view returns (address)',
]);

interface State {
  urls: { anvil: string };
  deploymentFile: string;
}

function stack(): State {
  const file = process.env.MTW_STACK_STATE;
  if (!file) throw new Error('falta MTW_STACK_STATE: este test corre con `pnpm test:e2e` (levanta el stack)');
  return JSON.parse(readFileSync(file, 'utf8')) as State;
}

async function anvil<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(stack().urls.anvil, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const reader = () => createPublicClient({ chain: base, transport: http(stack().urls.anvil) });

async function funded(): Promise<Hex> {
  const key = generatePrivateKey();
  await anvil('anvil_setBalance', [privateKeyToAddress(key), toHex(10n ** 18n)]);
  return key;
}

test('transferencia soberana con U (sobre + Password) y R (17 palabras), con la plataforma apagada', async ({
  page,
}) => {
  const envelopes = (
    JSON.parse(readFileSync(resolve(VECTORS, 'wire/envelope.json'), 'utf8')) as {
      envelopes: { keyLabel: string; password: string; envelope: { role: string } }[];
    }
  ).envelopes;
  const backups = (
    JSON.parse(readFileSync(resolve(VECTORS, 'wire/backup-words.json'), 'utf8')) as {
      backups: { role: string; words: string[] }[];
    }
  ).backups;
  const userVector = envelopes.find((e) => e.envelope.role === 'U');
  const recoveryWords = backups.find((b) => b.role === 'R')?.words;
  if (!userVector || !recoveryWords) throw new Error('faltan los vectores de U o de R');
  const U = privateKeyToAddress(keccak256(toBytes('mtw-user-key')));
  const R = privateKeyToAddress(keccak256(toBytes('mtw-recovery-key')));
  const S = privateKeyToAddress(generatePrivateKey());

  // La Safe de la factory del sistema desplegado en el fork del stack.
  const factory = (
    JSON.parse(readFileSync(stack().deploymentFile, 'utf8')) as {
      contracts: { WalletFactory: { address: Address } };
    }
  ).contracts.WalletFactory.address;
  const salt = BigInt(keccak256(toBytes(`sovereign-exit-${String(Date.now())}`)));
  const deployer = privateKeyToAccount(await funded());
  const writer = createWalletClient({ account: deployer, chain: base, transport: http(stack().urls.anvil) });
  const created = await writer.writeContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'createWallet',
    args: [U, R, S, salt],
  });
  await reader().waitForTransactionReceipt({ hash: created });
  const safe = await reader().readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'predictWalletAddress',
    args: [U, R, S, salt],
  });
  await anvil('anvil_setBalance', [USDC_HOLDER, toHex(10n ** 19n)]);
  await anvil('anvil_impersonateAccount', [USDC_HOLDER]);
  const funding = await anvil<Hex>('eth_sendTransaction', [
    {
      from: USDC_HOLDER,
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [safe, AMOUNT] }),
    },
  ]);
  await anvil('anvil_stopImpersonatingAccount', [USDC_HOLDER]);
  await reader().waitForTransactionReceipt({ hash: funding });

  await page.goto(pathToFileURL(resolve(ROOT, 'dist/sovereign-exit.html')).href);
  await page.getByLabel('RPC de Base').fill(stack().urls.anvil);
  await page.getByLabel('Dirección de tu Safe').fill(safe.toLowerCase());
  await page.getByRole('button', { name: 'Leer la Safe' }).click();
  await expect(page.locator('[data-safe-nonce]')).toBeVisible();
  await expect(page.locator('[data-out="safe"]')).toContainText(U);

  await page.getByLabel('Archivo del sobre U.enc').setInputFiles({
    name: 'U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(userVector.envelope)),
  });
  await page.getByLabel('Password U').fill(userVector.password);
  await page.getByRole('button', { name: 'Abrir U' }).click();
  await expect(page.locator('[data-out="key-U"]')).toContainText(`U abierta: ${U} (owner de la Safe)`);

  await page.locator('select[name="source-R"]').selectOption('words');
  await page.getByLabel('17 palabras de R').fill(recoveryWords.join(' '));
  await page.getByRole('button', { name: 'Abrir R' }).click();
  await expect(page.locator('[data-out="key-R"]')).toContainText(`R abierta: ${R} (owner de la Safe)`);

  const destination = privateKeyToAddress(generatePrivateKey());
  await page.getByLabel('Acción').selectOption('TRANSFER_USDC');
  await page.getByLabel('Dirección de destino').fill(destination);
  await page.getByRole('button', { name: 'Armar la operación' }).click();
  await expect(page.locator('[data-description]')).toHaveText(`Enviar 25 USDC a ${destination}`);
  await page.getByRole('button', { name: 'Firmar con U y R' }).click();
  await expect(page.locator('[data-out="sign"]')).toContainText('Firmada por U');
  const calldata = await page.getByLabel('Calldata de execTransaction (a la Safe)').inputValue();
  expect(calldata).toMatch(/^0x6a761202/);

  await page.getByLabel('Paga el gas', { exact: true }).selectOption('OTHER');
  await page.getByLabel('Clave privada de la cuenta que paga el gas').fill(await funded());
  await page.getByRole('button', { name: 'Transmitir' }).click();
  await expect(page.locator('[data-out="send"]')).toContainText(/Ejecutada en el bloque \d+/, { timeout: 180_000 });
  expect(
    await reader().readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [destination] }),
  ).toBe(AMOUNT);
  expect(await reader().readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [safe] })).toBe(
    0n,
  );
});
