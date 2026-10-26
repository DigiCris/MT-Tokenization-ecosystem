// P17.T05: onboarding de U en orden contra los servicios reales — conectar Drive (consentimiento respondido con un token
// real de la cuenta de prueba) → step-up ONBOARDING con el código del email → U y Password U → confirmar 2 palabras →
// sobre cifrado → subir a Drive y verificar (API real de Drive) → backup independiente (archivo y 17 palabras, que
// cuentan recién al reingresar 3 al azar) → registro OPAQUE y alta de U. El archivo descargado abre con la Password U
// mostrada y contiene la U registrada.
import { expect, test } from '@playwright/test';
import { backupWordsToKey } from '../../frontend/wallet/src/crypto/backup-words.ts';
import {
  keysForEnvelope,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../../frontend/wallet/src/crypto/envelope.ts';
import { addressOf } from '../../frontend/wallet/src/crypto/keys.ts';
import { downloadEnvelope } from '../../frontend/wallet/src/drive/backup.ts';
import { answerGoogleConsent, removeEnvelopeBackup, testDrive } from '../fixtures/wallet/drive.ts';
import { nodeArgon2, testWordlist, verifiedAccount } from '../fixtures/wallet/onboard.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  writeDownAndConfirmBackupWords,
  writeDownAndConfirmPassword,
} from '../fixtures/wallet/ui.ts';

test('onboarding de U: Drive → step-up → Password U → backups → registro', async ({ page }) => {
  const account = await verifiedAccount('onboarding');
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(/\/onboarding$/);

  await answerGoogleConsent(page);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible();
  await completeStepUp(page, account.email);

  const words = await writeDownAndConfirmPassword(page);
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();

  await page.getByRole('button', { name: 'Subir a Drive y verificar' }).click();
  await expect(page.getByText('Sobre subido a Drive y verificado.')).toBeVisible();
  const file = await backupToFile(page);
  // Al confirmar 3 palabras, las 17 dejan de mostrarse (se muestran sólo en este paso).
  const backupWords = await writeDownAndConfirmBackupWords(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  // P18: después del registro sigue la activación de Recovery.
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();

  // El sobre descargado abre con la Password U mostrada y es el mismo que quedó en Drive.
  const envelope = parseEnvelope(JSON.parse(file));
  const keys = await keysForEnvelope(envelope, words.join(' '), nodeArgon2);
  const key = await openEnvelope(envelope, keys.encryptionKey);
  expect(addressOf(key)).toBe(envelope.keyAddress);
  const restored = await backupWordsToKey('U', backupWords, testWordlist());
  expect(addressOf(restored)).toBe(envelope.keyAddress);
  const fromDrive = await downloadEnvelope(await testDrive());
  try {
    expect(fromDrive?.keyAddress).toBeDefined();
    const { wallet } = await account.api.myWallet();
    expect(wallet).toMatchObject({ id: envelope.walletId, status: 'CREATING' });

    // [F-DRV-05] chequeo periódico, sin bloquear nada: a los 7 días aparece el aviso; con Drive reconectado se verifica
    // contra el hash del sobre; si el archivo falta queda la alerta y se re-sube el sobre recordado en el dispositivo.
    await page.clock.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
    await page.goto('/security');
    await expect(page.getByRole('status').filter({ hasText: 'Toca verificar que el backup' })).toBeVisible();
    await page.getByRole('button', { name: 'Conectar Drive para verificar el backup' }).click();
    await expect(page).toHaveURL(/\/security$/);
    await page.getByRole('button', { name: 'Verificar el backup en Drive' }).click();
    // El estado es el de la última verificación y lleva su fecha y hora.
    const ok = /^En la última verificación \(.*\d{2}:\d{2}\), el backup en Drive estaba y coincidía con tu sobre\.$/;
    await expect(page.getByText(ok)).toBeVisible();
    expect(await removeEnvelopeBackup(serializeEnvelope(envelope))).toBe(1);
    await page.getByRole('button', { name: 'Verificar el backup en Drive' }).click();
    await expect(page.getByText(/faltaba el backup en Drive: volvé a subirlo\.$/)).toBeVisible();
    await page.getByRole('button', { name: 'Volver a subir el sobre' }).click();
    await expect(page.getByText(ok)).toBeVisible();
  } finally {
    await removeEnvelopeBackup(serializeEnvelope(envelope));
  }
});

test('sin backup independiente no se puede seguir; Drive solo no alcanza', async ({ page }) => {
  const account = await verifiedAccount('sin-backup');
  await login(page, account.email, account.password);
  await page.getByRole('button', { name: 'Seguir sin Drive' }).click();
  await completeStepUp(page, account.email);
  await writeDownAndConfirmPassword(page);
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();
  await expect(page.getByText('Drive no está conectado en esta sesión')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  await page.getByRole('button', { name: 'Mostrar QR' }).click();
  await expect(page.getByRole('img', { name: /QR del sobre cifrado/ }).first()).toBeVisible();
  await page.getByLabel(/^Guardé o imprimí (el QR|las \d+ partes del QR) fuera de este dispositivo/).check();
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeEnabled();
});
