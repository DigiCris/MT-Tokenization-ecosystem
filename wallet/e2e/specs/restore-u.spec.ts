// P17.T09 [F-KEY-10]: restaurar U en un dispositivo nuevo (contexto de navegador vacío) contra los servicios reales:
// desde el archivo y desde el QR (cámara simulada de Chromium con un video del QR del sobre) con la Password U de
// siempre; desde las 17 palabras, verificadas contra el rol U on-chain (RPC del frontend → fork del stack), con Password
// U nueva, step-up KEY_RESTORE con prueba de posesión y reemplazo del registro OPAQUE. Una clave que no es la U vigente
// no se restaura.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import { keyToBackupWords } from '../../frontend/wallet/src/crypto/backup-words.ts';
import {
  keysForEnvelope,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../../frontend/wallet/src/crypto/envelope.ts';
import { addressOf, generatePrivateKey } from '../../frontend/wallet/src/crypto/keys.ts';
import { encodeFrames } from '../../frontend/wallet/src/qr/frames.ts';
import { unlockWallet } from '../../frontend/wallet/src/unlock/unlock.ts';
import { activeWallet, nodeArgon2, testWordlist, type ActiveWallet } from '../fixtures/wallet/onboard.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  shownAddress,
  writeDownAndConfirmPassword,
} from '../fixtures/wallet/ui.ts';
import { writeQrVideo } from '../fixtures/wallet/y4m.ts';

const VIDEO = resolve(import.meta.dirname, '../../../test-results/stack/qr-envelope.y4m');
let wallet: ActiveWallet;

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  },
});

test.beforeAll(async () => {
  test.setTimeout(600_000);
  wallet = await activeWallet('restore');
  mkdirSync(dirname(VIDEO), { recursive: true });
  writeQrVideo(VIDEO, await encodeFrames(JSON.stringify(wallet.envelope)));
});

test('desde el archivo cifrado y la Password U', async ({ page }) => {
  await login(page, wallet.email, wallet.password);
  await page.goto('/restore');
  await page.getByRole('button', { name: /Con el sobre cifrado/ }).click();
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeEnvelope(wallet.envelope)),
  });
  await page.getByLabel('Password U').fill(wallet.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Restaurar y desbloquear' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toContainText(
    shownAddress(wallet.userAddress),
  );
});

test('desde el QR del sobre leído con la cámara', async ({ page }) => {
  await login(page, wallet.email, wallet.password);
  await page.goto('/restore');
  await page.getByRole('button', { name: /Con el sobre cifrado/ }).click();
  await page.getByRole('button', { name: 'Desde el QR' }).click();
  await expect(
    page.getByText('Sobre cifrado de tu clave U').locator(`[data-address="${getAddress(wallet.userAddress)}"]`),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Password U').fill(wallet.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Restaurar y desbloquear' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toContainText(
    shownAddress(wallet.userAddress),
  );
});

test('desde las 17 palabras: rol U on-chain, KEY_RESTORE y Password U nueva; otra clave se rechaza', async ({
  page,
}) => {
  await login(page, wallet.email, wallet.password);
  await page.goto('/restore');
  await page.getByRole('button', { name: 'Con las 17 palabras' }).click();
  const stranger = await keyToBackupWords('U', generatePrivateKey(), testWordlist());
  await page.getByLabel('17 palabras').fill(stranger.join(' '));
  await page.getByRole('button', { name: 'Verificar palabras' }).click();
  await expect(page.getByRole('alert')).toContainText('no se restaura');

  const words = await keyToBackupWords('U', wallet.userKey, testWordlist());
  await page.getByLabel('17 palabras').fill(words.join('  ').toUpperCase());
  await page.getByRole('button', { name: 'Verificar palabras' }).click();
  await expect(page.getByText('Las palabras corresponden a la U vigente de tu Safe.')).toBeVisible();
  const newWords = await writeDownAndConfirmPassword(page);
  await completeStepUp(page, wallet.email);
  await expect(page.getByText('Tus 17 palabras siguen siendo un backup válido de esta misma clave.')).toBeVisible();
  const file = await backupToFile(page);
  await page.getByRole('button', { name: 'Terminar la restauración' }).click();
  await expect(page.getByText('Tu clave quedó restaurada con la Password U nueva')).toBeVisible();

  const envelope = parseEnvelope(JSON.parse(file));
  expect(envelope).toMatchObject({ keyAddress: wallet.userAddress, walletId: wallet.wallet.id, keyVersion: 1 });
  const key = await openEnvelope(
    envelope,
    (await keysForEnvelope(envelope, newWords.join(' '), nodeArgon2)).encryptionKey,
  );
  expect(addressOf(key)).toBe(wallet.userAddress);
  await expect(
    unlockWallet(wallet.api, wallet.envelope, wallet.passwordWords.join(' '), nodeArgon2),
  ).rejects.toMatchObject({
    reason: 'RECORD_MISMATCH',
  });
  expect((await unlockWallet(wallet.api, envelope, newWords.join(' '), nodeArgon2)).session.scope).toBe('OPERATIONS');
});
