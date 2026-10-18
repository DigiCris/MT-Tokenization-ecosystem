// P18.T09.a contra los servicios reales y el fork: reemplazar Recovery (R perdida o comprometida). La app pide un
// enrollment de reemplazo, la app Recovery (Node, por el listener de Recovery) envía R′ con su KeyAcceptance, la Wallet
// confirma R′ con la comparación manual, U firma la propuesta armada por la app y, a las 48 h, la ejecución: R′ queda
// como owner y como R del Guard.
import { expect, test } from '@playwright/test';
import { getAddress, type Hex } from 'viem';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { confirmGroupsManually } from './helpers/activation.ts';
import { chain, increaseTime } from './helpers/chain.ts';
import { activeWallet, submitRecovery } from './helpers/onboard.ts';
import { backendKnowsProposal, contract } from './helpers/operate.ts';
import { openSecurity, settled, unlockToHome } from './helpers/ui.ts';

test('reemplazar Recovery: R′ confirmada, propuesta firmada por U y ejecución a las 48 h', async ({ page }) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('replace-r');
  await unlockToHome(page, wallet);

  await openSecurity(page, 'Estado y reemplazo de tu clave de recuperación (R)');
  await expect(page.locator(`[data-address="${getAddress(wallet.recovery.address)}"]`)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Reemplazar mi clave de recuperación' }).click();
  const link = await page.locator('[data-recovery-link]').getAttribute('data-recovery-link');
  const fragment = new URLSearchParams(new URL(link ?? '').hash.slice(1));
  const replacement = await submitRecovery(wallet, {
    enrollmentId: fragment.get('eid') ?? '',
    nonce: (fragment.get('n') ?? '0x') as Hex,
    walletId: wallet.wallet.id,
  });
  await confirmGroupsManually(page, replacement.address);
  await page.getByRole('button', { name: 'Revisar la propuesta' }).click();
  await expect(page.getByText(/Proponer reemplazar tu clave de recuperación \(R\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(page.getByText(/Propuesta enviada: se puede ejecutar dentro de 48 h/)).toBeVisible({ timeout: 240_000 });
  await backendKnowsProposal(wallet, 'R');

  await increaseTime(48 * 3600 + 60);
  await page.getByRole('link', { name: 'Rotaciones', exact: true }).click();
  const row = page.locator('li[data-role="R"]');
  await expect(row).toContainText('Se puede ejecutar.', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Ejecutar' }).click();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(settled(page)).toBeVisible({ timeout: 240_000 });
  const roles = await chain().readContract({
    address: contract('SecurityGuard'),
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [wallet.wallet.safe],
  });
  expect(getAddress(roles.recoveryKey)).toBe(getAddress(replacement.address));
});
