// P18.T09.a contra los servicios reales y el fork: reemplazar Recovery (R perdida o comprometida). La app pide un
// enrollment de reemplazo, la app Recovery (Node, por el listener de Recovery) envía R′ con su KeyAcceptance, la Wallet
// confirma R′ con la comparación manual o con el enlace de regreso (con el k del pedido, ADR-033), U firma la propuesta
// armada por la app y, a las 48 h, la ejecución: R′ queda como owner y como R del Guard.
//
// Revisión de seguridad de ADR-033 (ALTO 1): con la propuesta ya enviada, un rechazo del pedido de R′ (por ejemplo, un
// aviso tardío) no se acepta (409) y el pedido sigue SUBMITTED; a las 48 h la ejecución on-chain lo deja CONFIRMED y la
// sincronización de rotaciones sigue aplicando eventos (antes, un pedido REJECTED con la rotación en curso trababa la
// sincronización de todas las wallets).
import { expect, test } from '@playwright/test';
import { getAddress, type Hex } from 'viem';
import { ApiError } from '../../../src/api/problem.ts';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { confirmGroupsManually, returnLinkPath } from './helpers/activation.ts';
import { chain, increaseTime } from './helpers/chain.ts';
import { activeWallet, submitRecovery, type ActiveWallet } from './helpers/onboard.ts';
import { backendKnowsProposal, contract, unlockInNode } from './helpers/operate.ts';
import { openSecurity, settled, unlockToHome } from './helpers/ui.ts';
import type { Page } from '@playwright/test';

/** Abre el reemplazo de R y devuelve el pedido del enlace de ida (id, nonce y k). */
async function startReplacement(page: Page, wallet: ActiveWallet) {
  await openSecurity(page, 'Estado y reemplazo de tu clave de recuperación (R)');
  await expect(page.locator(`[data-address="${getAddress(wallet.recovery.address)}"]`)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Reemplazar mi clave de recuperación' }).click();
  const link = await page.locator('[data-recovery-link]').getAttribute('data-recovery-link');
  const fragment = new URLSearchParams(new URL(link ?? '').hash.slice(1));
  return {
    enrollmentId: fragment.get('eid') ?? '',
    nonce: (fragment.get('n') ?? '0x') as Hex,
    secret: fragment.get('k') ?? '',
  };
}

test('reemplazar Recovery: R′ confirmada, propuesta firmada por U y ejecución a las 48 h; el pedido ya no se rechaza', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('replace-r');
  await unlockToHome(page, wallet);

  const request = await startReplacement(page, wallet);
  const replacement = await submitRecovery(wallet, { ...request, walletId: wallet.wallet.id });
  await confirmGroupsManually(page, replacement.address);
  await page.getByRole('button', { name: 'Revisar la propuesta' }).click();
  await expect(page.getByText(/Proponer reemplazar tu clave de recuperación \(R\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(page.getByText(/Propuesta enviada: se puede ejecutar dentro de 48 h/)).toBeVisible({ timeout: 240_000 });
  await backendKnowsProposal(wallet, 'R');

  // Con la rotación hacia R′ en curso, el rechazo de su pedido no se acepta: la cadena la ejecutaría igual.
  const unlocked = await unlockInNode(wallet);
  const refused = await wallet.api.client
    .request('POST', `/recovery/enrollments/${request.enrollmentId}/reject`, {
      platform: unlocked.platform,
      body: { reason: 'RETURN_LINK_KEY_MISMATCH' },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(refused).toBeInstanceOf(ApiError);
  expect((refused as ApiError).status).toBe(409);
  expect(await wallet.api.getRecoveryEnrollment(request.enrollmentId)).toMatchObject({
    status: 'SUBMITTED',
    rejectionReason: null,
  });

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
  // La sincronización aplicó la ejecución: el pedido de R′ quedó CONFIRMED y la rotación EXECUTED.
  await expect
    .poll(() => wallet.api.getRecoveryEnrollment(request.enrollmentId), { timeout: 120_000 })
    .toMatchObject({ status: 'CONFIRMED', rejectionReason: null });
  await expect
    .poll(async () => (await wallet.api.listRotations(wallet.wallet.id)).items.find((r) => r.role === 'R')?.status, {
      timeout: 120_000,
    })
    .toBe('EXECUTED');
});

test('reemplazar Recovery con el enlace de regreso en otra pestaña (con el k del pedido): R′ se confirma sola', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const wallet = await activeWallet('replace-r-link');
  await unlockToHome(page, wallet);
  const request = await startReplacement(page, wallet);
  expect(request.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const replacement = await submitRecovery(wallet, { ...request, walletId: wallet.wallet.id });
  await expect(page.getByRole('button', { name: 'Confirmar la dirección de R' })).toBeVisible({ timeout: 60_000 });

  const other = await context.newPage();
  await other.goto(returnLinkPath(request, replacement.address));
  await expect(other.locator('[data-return-outcome="confirmed"]')).toBeVisible();
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: 'Proponer el reemplazo' })).toBeVisible();
  await expect(page.locator(`[data-address="${getAddress(replacement.address)}"]`)).toBeVisible();
});
