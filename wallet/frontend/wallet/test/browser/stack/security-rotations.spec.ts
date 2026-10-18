// P18.T09 y P18.T09.b contra los servicios reales y el fork: la plataforma pide rotar S (operador real con la CLI y su
// TOTP) y la app lo avisa en el inicio; en Rotaciones muestra el motivo y la S′ con su atestación verificada con la clave
// fijada, U firma la propuesta armada por la app y la S′ queda en el timelock on-chain. U la cancela con su firma
// EIP-712 por el relay, o exportando la firma para que la transmita cualquiera (aquí, un relayer sin relación con la
// plataforma); un nuevo pedido madura con las 48 h y U lo ejecuta (swapOwner con el owner anterior leído de la cadena):
// S′ queda como owner y como S del Guard. Seguridad muestra el estado de Recovery (R leída del Guard).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { iSafeAbi } from '../../../src/chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../../../src/chain/abis/RotationTimelock.ts';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { anvil, chain, increaseTime, receipt } from './helpers/chain.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { backendKnowsProposal, contract, ROTATION_KIND } from './helpers/operate.ts';
import { addOperator, type StackOperator } from './helpers/operators.ts';
import { stack } from './helpers/stack.ts';
import { goHome, openSecurity, settled, unlockToHome } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let operator: StackOperator;
let page: Page;

const ROTATIONS = 'Rotaciones (pendientes, cancelar, ejecutar)';

async function activeExecutorProposal(): Promise<Hex> {
  return chain().readContract({
    address: contract('RotationTimelock'),
    abi: rotationTimelockAbi,
    functionName: 'activeProposal',
    args: [wallet.wallet.safe, ROTATION_KIND.S],
  });
}

async function requestRotation(reason: string): Promise<Address> {
  const requested = (await operator.command([
    'executor:rotation-request',
    '--wallet',
    wallet.wallet.id,
    '--reason',
    reason,
  ])) as { newExecutor: Address };
  return getAddress(requested.newExecutor);
}

/** El backend ve la cancelación on-chain (sync de eventos) antes de que el operador pida otra rotación. */
async function backendSeesCancelled(): Promise<void> {
  await expect
    .poll(
      async () => {
        const { items } = await wallet.api.listRotations(wallet.wallet.id);
        return items.filter((r) => r.role === 'S' && !['CANCELLED', 'EXECUTED', 'FAILED'].includes(r.status)).length;
      },
      { timeout: 120_000 },
    )
    .toBe(0);
}

async function proposeFromPage(newExecutor: Address, reasonText: RegExp): Promise<void> {
  await openSecurity(page, ROTATIONS);
  const request = page.locator('[data-s-request]');
  await expect(request).toBeVisible({ timeout: 60_000 });
  await expect(request).toContainText(reasonText);
  await expect(request.locator(`[data-address="${newExecutor}"]`)).toBeVisible();
  await expect(page.getByText('La clave nueva está atestada por el signer de esta versión.')).toBeVisible();
  await page.getByRole('button', { name: 'Revisar y firmar la propuesta' }).click();
  await expect(page.getByText(/Proponer reemplazar la clave de la plataforma \(S\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  await expect.poll(activeExecutorProposal, { timeout: 60_000 }).not.toMatch(/^0x0{64}$/);
  await backendKnowsProposal(wallet, 'S');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  wallet = await activeWallet('rotations');
  operator = await addOperator('ops');
  page = await browser.newPage();
  await unlockToHome(page, wallet);
});

test.afterAll(async () => {
  // Si el beforeAll falló antes de abrir la página, no hay nada que cerrar.
  await (page as Page | undefined)?.close();
});

test('estado de Recovery en Seguridad: la R leída del Guard', async () => {
  await openSecurity(page, 'Estado y reemplazo de tu clave de recuperación (R)');
  await expect(page.locator(`[data-address="${getAddress(wallet.recovery.address)}"]`)).toBeVisible({
    timeout: 60_000,
  });
});

test('la plataforma pide rotar S: aviso, motivo, S′ atestada, propuesta firmada por U y S′ en el timelock', async () => {
  const newExecutor = await requestRotation('HSM_MIGRATION');
  await goHome(page);
  await expect(page.getByText('La plataforma pidió rotar su clave (S).')).toBeVisible({ timeout: 60_000 });
  await proposeFromPage(newExecutor, /módulo de hardware \(HSM\)/);
  const proposal = await chain().readContract({
    address: contract('RotationTimelock'),
    abi: rotationTimelockAbi,
    functionName: 'getProposal',
    args: [await activeExecutorProposal()],
  });
  expect(getAddress(proposal.newValue)).toBe(newExecutor);
  await page.getByRole('button', { name: 'Volver a las rotaciones' }).click();
  await expect(page.locator('li[data-role="S"]')).toBeVisible({ timeout: 60_000 });
});

test('U cancela con su firma EIP-712 por el relay: la propuesta sale del timelock', async () => {
  const row = page.locator('li[data-role="S"]');
  await row.getByRole('button', { name: 'Cancelar con mi firma' }).click();
  await expect(page.getByText('Cancelación enviada: se confirma con el evento on-chain.')).toBeVisible();
  await expect.poll(activeExecutorProposal, { timeout: 120_000 }).toMatch(/^0x0{64}$/);
  await openSecurity(page, ROTATIONS);
  await expect(page.getByText('No hay rotaciones pendientes.')).toBeVisible({ timeout: 60_000 });
  await backendSeesCancelled();
});

test('U exporta la firma de cancelación y un relayer cualquiera la transmite', async () => {
  const newExecutor = await requestRotation('SHARD_MIGRATION');
  await proposeFromPage(newExecutor, /otro servidor de firma de la plataforma/);
  await page.getByRole('button', { name: 'Volver a las rotaciones' }).click();
  const row = page.locator('li[data-role="S"]');
  const downloading = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Exportar la firma de cancelación' }).click();
  const exported = JSON.parse(readFileSync(await (await downloading).path(), 'utf8')) as {
    chainId: number;
    timelock: Address;
    proposalId: Hex;
    safe: Address;
    signature: Hex;
    call: Hex;
  };
  expect(exported).toMatchObject({
    chainId: 8453,
    safe: wallet.wallet.safe,
    proposalId: await activeExecutorProposal(),
  });
  expect(getAddress(exported.timelock)).toBe(contract('RotationTimelock'));
  await expect(page.getByText('Firma exportada: transmitila con cualquier wallet.')).toBeVisible();

  const relayer = privateKeyToAccount(generatePrivateKey());
  await anvil('anvil_setBalance', [relayer.address, `0x${(10n ** 18n).toString(16)}`]);
  const client = createWalletClient({ account: relayer, chain: base, transport: http(stack().urls.anvil) });
  const hash = await client.sendTransaction({ to: exported.timelock, data: exported.call, gas: 300_000n });
  expect((await receipt(hash)).status).toBe('success');
  expect(await activeExecutorProposal()).toMatch(/^0x0{64}$/);
  await backendSeesCancelled();
});

test('rotación madura: a las 48 h U la ejecuta y S′ queda como owner y como S del Guard', async () => {
  const newExecutor = await requestRotation('MAINTENANCE');
  await proposeFromPage(newExecutor, /mantenimiento preventivo de la clave/);
  await increaseTime(48 * 3600 + 60);
  await page.getByRole('button', { name: 'Volver a las rotaciones' }).click();
  await openSecurity(page, ROTATIONS);
  const row = page.locator('li[data-role="S"]');
  await expect(row).toContainText('Se puede ejecutar.', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Ejecutar' }).click();
  await expect(page.getByText(/Reemplazar en la Safe la clave 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  const owners = await chain().readContract({ address: wallet.wallet.safe, abi: iSafeAbi, functionName: 'getOwners' });
  expect(owners.map((o) => getAddress(o))).toContain(newExecutor);
  const roles = await chain().readContract({
    address: contract('SecurityGuard'),
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [wallet.wallet.safe],
  });
  expect(getAddress(roles.executor)).toBe(newExecutor);
});
