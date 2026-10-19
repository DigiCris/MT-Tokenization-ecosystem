// P17.MAN (R-14): recorrido del onboarding completo contra los servicios reales con capturas de cada pantalla para el
// agente revisor (textos de advertencia): registro y olvido de contraseña de cuenta, conexión de Drive, step-up, Password
// U, confirmación de palabras, sobre, subida a Drive, backups independientes (archivo, QR y 17 palabras), alta de U,
// activación de Recovery con R confirmada a mano, creación de la Safe y el inicio. Corre en cada navegador de
// MTW_BROWSERS y sólo con MTW_REVIEW_DIR (capturas en <dir>/onboarding/<navegador>/).
import { expect, test } from '@playwright/test';
import { serializeEnvelope, parseEnvelope } from '../../../../src/crypto/envelope.ts';
import { confirmGroupsManually } from '../helpers/activation.ts';
import { answerGoogleConsent, removeEnvelopeBackup } from '../helpers/drive.ts';
import { submitRecovery, verifiedAccount } from '../helpers/onboard.ts';
import { backupToFile, completeStepUp, login, writeDownAndConfirmPassword } from '../helpers/ui.ts';
import { reviewCamera } from './camera.ts';

test('onboarding completo con capturas para la revisión de textos', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const snap = reviewCamera(page, 'onboarding', testInfo.project.name);
  await page.goto('/register');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await snap('registro');
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await snap('olvide-la-contrasena');

  const account = await verifiedAccount('review-onboarding');
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(/\/onboarding$/);
  await snap('onboarding-drive');
  await answerGoogleConsent(page);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible();
  await snap('step-up');
  await completeStepUp(page, account.email);
  await expect(page.locator('ol[aria-label="Password U"] .words__word')).toHaveCount(5, { timeout: 60_000 });
  await snap('password-u');
  const words = await writeDownAndConfirmPassword(page);
  await expect(page.getByRole('button', { name: 'Cifrar', exact: true })).toBeVisible();
  await snap('cifrar');
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Subir a Drive y verificar' })).toBeVisible();
  await snap('backups');
  await page.getByRole('button', { name: 'Subir a Drive y verificar' }).click();
  await expect(page.getByText('Sobre subido a Drive y verificado.')).toBeVisible();
  const file = await backupToFile(page);
  await page.getByRole('button', { name: 'Mostrar QR' }).click();
  await expect(page.getByRole('img', { name: /QR del sobre cifrado/ }).first()).toBeVisible();
  await snap('backup-qr');
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  await expect(page.getByRole('list', { name: '17 palabras de la clave' }).locator('.words__word')).toHaveCount(17);
  await snap('backup-17-palabras');
  await page.getByLabel(/Anoté las 17 palabras/).click();
  await expect(page.getByText('Palabras anotadas.')).toBeVisible();
  await snap('backups-completos');
  const envelope = parseEnvelope(JSON.parse(file));
  try {
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('button', { name: 'Registrar', exact: true })).toBeVisible();
    await snap('registrar-u');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
    await expect(page.locator('[data-recovery-link]')).toBeVisible();
    await snap('activar-recovery');

    const link = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
    const fragment = new URLSearchParams(link.hash.slice(1));
    const r = await submitRecovery(account, {
      enrollmentId: fragment.get('eid') ?? '',
      nonce: (fragment.get('n') ?? '0x') as `0x${string}`,
    });
    await expect(page.getByText('Recovery envió esta clave R:')).toBeVisible({ timeout: 60_000 });
    await snap('confirmar-r');
    await confirmGroupsManually(page, r.address);
    await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
    await page.getByRole('button', { name: 'Preparar la Safe' }).click();
    await expect(page.locator('[data-expected-safe]')).toBeVisible({ timeout: 60_000 });
    await snap('crear-safe');
    await page.getByRole('button', { name: 'Firmar y crear la Safe' }).click();
    await expect(page.getByRole('heading', { name: 'Tu Safe está operativa' })).toBeVisible({ timeout: 300_000 });
    await snap('safe-operativa');
    await page.goto('/security');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await snap('seguridad');
    await page.goto('/security/lost-password-u');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await snap('perdi-la-password-u');
    expect(words).toHaveLength(5);
  } finally {
    await removeEnvelopeBackup(serializeEnvelope(envelope));
  }
});
