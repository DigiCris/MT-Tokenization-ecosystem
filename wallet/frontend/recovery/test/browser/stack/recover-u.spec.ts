// P19.T04 contra los servicios reales y el fork (P19.TST: recovery de U con warp de 48 h): la Wallet registró U′ por
// "Perdí mi Password U" (por API) y dejó la rotación en borrador. En Recovery, R (sobre desbloqueado con la Password R)
// ve U′ completa para compararla, firma la propuesta que arma la app (R + S, timelock de 48 h), ve la cuenta regresiva
// con la hora de la cadena y, a las 48 h, firma la ejecución: U′ queda como owner de la Safe y como U del Guard.
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { increaseTime, safeState } from './helpers/chain.ts';
import { sealRecovery, type SealedRecovery } from './helpers/envelope.ts';
import { activeWallet, replaceUserKey, type ActiveWallet, type UserKey } from './helpers/onboard.ts';
import { advanceRateLimitWindows } from './helpers/stack.ts';
import { settled, throughGate } from './helpers/ui.ts';

test.describe.configure({ mode: 'serial' });

let wallet: ActiveWallet;
let sealed: SealedRecovery;
let newUser: UserKey;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  const key = generatePrivateKey();
  const recovery = privateKeyToAccount(key);
  wallet = await activeWallet('recover-u', recovery);
  sealed = await sealRecovery(recovery, key, wallet.walletId);
  ({ newUser } = await replaceUserKey(wallet));
  // La cuenta ya pidió tres códigos por email (onboarding, enrollment y U_REPLACEMENT): el límite es 3 cada 10 min por
  // cuenta ([B-RL]) y el step-up RECOVERY de Recovery sería el cuarto; en la realidad pasa más tiempo entre los pasos.
  advanceRateLimitWindows();
});

test('R propone U → U′ (la U′ completa a la vista) y a las 48 h ejecuta: U′ es owner y U del Guard', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/recover-u');
  await throughGate(page, wallet.account.email, sealed);
  await expect(page.getByRole('heading', { name: 'Recuperar tu clave de usuario (U)' })).toBeVisible({
    timeout: 60_000,
  });
  const draft = page.locator('[data-draft-u]');
  await expect(draft.locator(`[data-address="${newUser.account.address}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Coincide: revisar y firmar la propuesta' }).click();
  await expect(page.getByText(/Proponer reemplazar tu clave de usuario \(U\) 0x .+ por 0x /)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(page.locator('[data-pending-u]')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/Se puede ejecutar desde el .+ \(hora de la red\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ejecutar el reemplazo' })).toHaveCount(0);

  await increaseTime(48 * 3600 + 60);
  await expect(page.getByRole('button', { name: 'Ejecutar el reemplazo' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Ejecutar el reemplazo' }).click();
  await expect(page.getByText(/Reemplazar en la Safe la clave 0x .+ por 0x /)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(settled(page).or(page.getByText('No hay un reemplazo de U pendiente.'))).toBeVisible({
    timeout: 240_000,
  });

  const onchain = await safeState(wallet.safe);
  expect(onchain.owners).toContain(newUser.account.address);
  expect(onchain.owners).not.toContain(wallet.user.account.address);
  expect(onchain.roles.userKey).toBe(newUser.account.address);
});
