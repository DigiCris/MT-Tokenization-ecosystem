// P19.T04 contra los servicios reales y el fork (P19.TST: recovery de U con warp de 48 h): la Wallet registró U′ por
// "Perdí mi Password U" (por API) y dejó la rotación en borrador. En Recovery, R (sobre desbloqueado con la Password R)
// no ve la U′ que informa la plataforma hasta confirmarla ([F-LNK-04], ESC-41): el usuario copia los 10 grupos de la
// dirección que muestra la Wallet (acá, el dato del test, nunca la pantalla de Recovery); con un grupo mal copiado se
// le dice cuál, sin revelar la dirección. Ya confirmada, R firma la propuesta que arma la app hacia esa U′ (R + S,
// timelock de 48 h), ve la cuenta regresiva con la hora de la cadena y, a las 48 h, firma la ejecución: U′ queda como
// owner de la Safe y como U del Guard.
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { increaseTime, safeState } from './helpers/chain.ts';
import { sealRecovery, type SealedRecovery } from './helpers/envelope.ts';
import { activeWallet, replaceUserKey, type ActiveWallet, type UserKey } from './helpers/onboard.ts';
import { advanceRateLimitWindows } from './helpers/stack.ts';
import { addressGroupsOf, settled, throughGate, typeAddressGroups } from './helpers/ui.ts';

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

test('R confirma U′ copiada de la Wallet (antes no se muestra), propone U → U′ y a las 48 h ejecuta: U′ es owner y U del Guard', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto('/recover-u');
  await throughGate(page, wallet.account.email, sealed);
  await expect(page.getByRole('heading', { name: 'Recuperar tu clave de usuario (U)' })).toBeVisible({
    timeout: 60_000,
  });
  const draft = page.locator('[data-draft-u]');
  await expect(draft.getByLabel('Grupo 1 de 10', { exact: true })).toBeVisible();
  // La U′ que informa la plataforma no está en la pantalla antes de compararla.
  await expect(page.locator(`[data-address="${newUser.account.address}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revisar y firmar la propuesta' })).toHaveCount(0);

  // Un grupo mal copiado: se dice cuál, sin revelar la dirección, y quedan 2 intentos.
  const groups = addressGroupsOf(newUser.account.address);
  const typo = [...groups];
  typo[5] = groups[5]?.toLowerCase() === 'ffff' ? '0000' : 'ffff';
  await typeAddressGroups(page, typo);
  await page.getByRole('button', { name: 'Confirmar la dirección de la clave U nueva' }).click();
  await expect(draft.locator('[data-mismatch-groups="6"]')).toBeVisible();
  await expect(
    draft.getByText('revisá el grupo 6 y volvé a confirmar (te quedan 2 intentos)', { exact: false }),
  ).toBeVisible();
  await expect(page.locator(`[data-address="${newUser.account.address}"]`)).toHaveCount(0);

  // Copiada bien: recién ahí se muestra la U′ confirmada y se puede revisar la propuesta.
  await typeAddressGroups(page, groups);
  await page.getByRole('button', { name: 'Confirmar la dirección de la clave U nueva' }).click();
  await expect(draft.locator(`[data-u-confirmed] [data-address="${newUser.account.address}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Revisar y firmar la propuesta' }).click();
  await expect(
    page.getByText(/Proponer reemplazar la dirección de tu clave de usuario \(U\) 0x .+ por 0x /),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(page.locator('[data-pending-u]')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/Se puede ejecutar desde el .+ \(hora de la red\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ejecutar el reemplazo' })).toHaveCount(0);

  await increaseTime(48 * 3600 + 60);
  await expect(page.getByRole('button', { name: 'Ejecutar el reemplazo' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Ejecutar el reemplazo' }).click();
  await expect(
    page.getByText(/Reemplazar en la Safe la dirección de la clave actual 0x .+ por la de la clave nueva 0x /),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(settled(page).or(page.getByText('No hay un reemplazo de U pendiente.'))).toBeVisible({
    timeout: 240_000,
  });

  const onchain = await safeState(wallet.safe);
  expect(onchain.owners).toContain(newUser.account.address);
  expect(onchain.owners).not.toContain(wallet.user.account.address);
  expect(onchain.roles.userKey).toBe(newUser.account.address);
});
