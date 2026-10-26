// P17.T07: cambio de Password U [F-KEY-08] con la wallet desbloqueada (sobre nuevo de la misma U, registro OPAQUE nuevo
// con OPERATIONS, el anterior retirado) y "perdí mi Password U" (step-up U_REPLACEMENT → U' con Password U' y backups →
// KeyAcceptance → borrador de rotación para que R la proponga → handoff a Recovery con link y QR, y la dirección de U'
// que generó la app a la vista, en grupos, para copiarla en Recovery).
import { expect, test } from '@playwright/test';
import {
  keysForEnvelope,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../../frontend/wallet/src/crypto/envelope.ts';
import { addressOf } from '../../frontend/wallet/src/crypto/keys.ts';
import { addressGroups } from '../../frontend/wallet/src/recovery-activation/activation.ts';
import { NEW_USER_KEY_COMPARE_TEXT } from '../../frontend/wallet/src/security/password-u/lost.ts';
import { unlockWallet } from '../../frontend/wallet/src/unlock/unlock.ts';
import { activeWallet, nodeArgon2 } from '../fixtures/wallet/onboard.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  unlockWithFile,
  writeDownAndConfirmPassword,
} from '../fixtures/wallet/ui.ts';
import { recoveryUrl } from '../fixtures/stack.ts';

test('cambiar la Password U: la misma U con un sobre nuevo; la vieja ya no desbloquea', async ({ page }) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('cambio');
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();

  // Navegación dentro de la app (sin recargar): la wallet sigue desbloqueada en memoria.
  await page.getByRole('link', { name: 'Seguridad' }).click();
  await page.getByRole('link', { name: 'Cambiar la Password U' }).click();
  await page.getByRole('button', { name: 'Generar la Password U nueva' }).click();
  const words = await writeDownAndConfirmPassword(page);
  const file = await backupToFile(page);
  await page.getByRole('button', { name: 'Cambiar la Password U' }).click();
  await expect(page.getByText('la Password U nueva quedó registrada')).toBeVisible();

  const envelope = parseEnvelope(JSON.parse(file));
  expect(envelope.keyAddress).toBe(wallet.userAddress);
  expect(envelope.kdf.salt).not.toBe(wallet.envelope.kdf.salt);
  const key = await openEnvelope(
    envelope,
    (await keysForEnvelope(envelope, words.join(' '), nodeArgon2)).encryptionKey,
  );
  expect(addressOf(key)).toBe(wallet.userAddress);
  // Contra el backend: el sobre viejo con la Password U vieja ya no tiene registro OPAQUE que lo acepte.
  await expect(
    unlockWallet(wallet.api, wallet.envelope, wallet.passwordWords.join(' '), nodeArgon2),
  ).rejects.toMatchObject({
    reason: 'RECORD_MISMATCH',
  });
  const unlocked = await unlockWallet(wallet.api, envelope, words.join(' '), nodeArgon2);
  expect(unlocked.session).toMatchObject({ scope: 'OPERATIONS', walletId: wallet.wallet.id });
});

test("perdí mi Password U: U' registrada con KeyAcceptance y handoff a Recovery", async ({ page }) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('perdida');
  await login(page, wallet.email, wallet.password);
  await page.goto('/security/lost-password-u');
  await page.getByRole('button', { name: 'Empezar' }).click();
  await completeStepUp(page, wallet.email);
  const words = await writeDownAndConfirmPassword(page);
  const file = await backupToFile(page);
  await page.getByRole('button', { name: 'Registrar la clave nueva' }).click();
  await expect(page.getByRole('heading', { name: 'Seguí en la app Recovery' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR para continuar en Recovery' })).toBeVisible();

  const envelope = parseEnvelope(JSON.parse(file));
  expect(envelope.keyAddress).not.toBe(wallet.userAddress);
  expect(envelope.keyVersion).toBe(2);
  const key = await openEnvelope(
    envelope,
    (await keysForEnvelope(envelope, words.join(' '), nodeArgon2)).encryptionKey,
  );
  expect(addressOf(key)).toBe(envelope.keyAddress);
  // La dirección de U' que generó la app (la del sobre), agrupada, con qué hacer con ella en Recovery.
  const shown = page.locator(`[data-new-user-key="${envelope.keyAddress}"]`);
  await expect(shown.getByRole('heading', { name: 'Dirección de tu clave U nueva' })).toBeVisible();
  await expect(shown.locator(`[data-address="${envelope.keyAddress}"]`)).toHaveText(
    `0x ${addressGroups(envelope.keyAddress).join(' ')}`,
  );
  await expect(shown.getByText(NEW_USER_KEY_COMPARE_TEXT)).toBeVisible();
  const handoff = new URL((await page.getByTestId('recovery-handoff').getAttribute('href')) ?? '');
  expect(handoff.origin + handoff.pathname).toBe(recoveryUrl('/recover-u'));
  const params = new URLSearchParams(handoff.hash.slice(1));
  expect(params.get('u')).toBe(envelope.keyAddress);
  const { items } = await wallet.api.listRotations(wallet.wallet.id);
  expect(items.find((r) => r.id === params.get('rid'))).toMatchObject({
    role: 'U',
    status: 'DRAFT',
    oldKey: wallet.userAddress,
    newKey: envelope.keyAddress,
  });
});
