// P17.MAN (R-14): recorrido del onboarding completo contra los servicios reales con capturas de cada pantalla para el
// agente revisor (textos de advertencia): registro y olvido de contraseña de cuenta, conexión de Drive, step-up (pedido y
// código), Password U y su confirmación, sobre (con las opciones avanzadas abiertas), subida a Drive, backups
// independientes (archivo, QR y 17 palabras con su confirmación), alta de U, activación de Recovery con R confirmada a
// mano (la Wallet no muestra la R antes de confirmar; una dirección distinta avisa y, al agotar los intentos, el pedido se
// cancela y se genera otro), creación de la Safe con sus mensajes de progreso, Seguridad (con el QR re-exportado) y
// "perdí mi Password U". Corre en cada navegador de MTW_BROWSERS y sólo con MTW_REVIEW_DIR (capturas en
// <dir>/onboarding/<navegador>/).
import { expect, test, type Page, type Route } from '@playwright/test';
import type { Hex } from 'viem';
import { serializeEnvelope, parseEnvelope } from '../../../../src/crypto/envelope.ts';
import {
  addressGroups,
  MANUAL_ABORT_TEXT,
  MANUAL_MISMATCH_TEXT,
} from '../../../../src/recovery-activation/activation.ts';
import { typeRecoveryGroups, waitForManualConfirmation } from '../helpers/activation.ts';
import { answerGoogleConsent, removeEnvelopeBackup } from '../helpers/drive.ts';
import { nextCode } from '../helpers/mailpit.ts';
import { submitRecovery, verifiedAccount } from '../helpers/onboard.ts';
import { randomAddress } from '../helpers/operate.ts';
import { advanceRateLimitWindows, stack } from '../helpers/stack.ts';
import { backupToFile, login, writeDownAndConfirmBackupWords, writeDownAndConfirmPassword } from '../helpers/ui.ts';
import { reviewCamera } from './camera.ts';

/** El pedido del enlace a Recovery que muestra la Wallet. */
async function recoveryRequest(page: Page): Promise<{ enrollmentId: string; nonce: Hex }> {
  const link = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  const fragment = new URLSearchParams(link.hash.slice(1));
  return { enrollmentId: fragment.get('eid') ?? '', nonce: (fragment.get('n') ?? '0x') as Hex };
}

/**
 * Retiene el primer pedido que coincide hasta capturar el mensaje de progreso (no cambia mientras la app lo espera) y
 * después lo deja seguir, igual que a los demás.
 */
function holdForProgress(page: Page, progress: string, capture: () => Promise<void>) {
  let gate: Promise<void> | null = null;
  return async (route: Route) => {
    if (route.request().method() !== 'OPTIONS') {
      gate ??= (async () => {
        try {
          await expect(page.locator(`[data-progress="${progress}"]`)).toBeVisible({ timeout: 240_000 });
          await capture();
        } catch {
          // Sin la captura del mensaje el recorrido sigue igual.
        }
      })();
      await gate;
    }
    await route.continue();
  };
}

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
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await expect(page.getByLabel('Código del email')).toBeVisible();
  await snap('step-up-codigo');
  await page.getByLabel('Código del email').fill(await nextCode(account.email));
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(page.locator('ol[aria-label="Password U"] .words__word')).toHaveCount(5, { timeout: 60_000 });
  await snap('password-u');
  const words = await writeDownAndConfirmPassword(page, () => snap('confirmar-password-u'));
  await expect(page.getByRole('button', { name: 'Cifrar', exact: true })).toBeVisible();
  // Las opciones avanzadas abiertas para revisar el aviso de 128 MiB (queda desactivada).
  await page.getByText('Opciones avanzadas').click();
  await expect(page.getByLabel(/128 MiB de memoria/)).not.toBeChecked();
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
  await writeDownAndConfirmBackupWords(page, {
    onShown: () => snap('backup-17-palabras'),
    onConfirmScreen: () => snap('backup-17-palabras-confirmar'),
  });
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

    // La app Recovery informa R; la Wallet pide copiarla de Recovery sin mostrarla.
    const first = await submitRecovery(account, await recoveryRequest(page));
    await waitForManualConfirmation(page, first.address);
    await snap('confirmar-r');
    // Lo que muestra Recovery no coincide con lo que recibió la plataforma (R cambiada en el camino).
    await typeRecoveryGroups(page, addressGroups(randomAddress()));
    await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
    await snap('confirmar-r-no-coincide');
    for (let attempt = 2; attempt <= 3; attempt++) await typeRecoveryGroups(page, addressGroups(randomAddress()));
    await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
    await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
    await snap('confirmar-r-pedido-cancelado');
    await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
    await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
    // Un pedido nuevo con su propio step-up de Recovery: las ventanas de los códigos por email se adelantan.
    advanceRateLimitWindows();
    const r = await submitRecovery(account, await recoveryRequest(page));
    await waitForManualConfirmation(page, r.address);
    await typeRecoveryGroups(page, addressGroups(r.address));
    await expect(page.getByText('Dirección de tu clave R (confirmada):')).toBeVisible();
    await snap('confirmar-r-confirmada');
    await page.getByRole('button', { name: 'Continuar' }).click();

    await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
    await snap('preparar-safe');
    await page.getByRole('button', { name: 'Preparar la Safe' }).click();
    await expect(page.locator('[data-expected-safe]')).toBeVisible({ timeout: 60_000 });
    await snap('crear-safe');
    // Mensajes de progreso: cada pedido que sigue a un mensaje espera a que se capture.
    const incorporate = '**/api/v1/recovery/enrollments/*/incorporate';
    const deploy = '**/api/v1/wallets/*/deploy';
    const rpc = (url: URL) => url.origin === new URL(stack().urls.anvil).origin;
    await page.route(
      incorporate,
      holdForProgress(page, 'signing', () => snap('crear-safe-firmando')),
    );
    await page.route(
      deploy,
      holdForProgress(page, 'deploying', () => snap('crear-safe-desplegando')),
    );
    await page.route(
      rpc,
      holdForProgress(page, 'verifying', () => snap('crear-safe-verificando')),
    );
    await page.getByRole('button', { name: 'Firmar y crear la Safe' }).click();
    await expect(page.getByRole('heading', { name: 'Tu Safe está operativa' })).toBeVisible({ timeout: 300_000 });
    await snap('safe-operativa');
    await page.unroute(incorporate);
    await page.unroute(deploy);
    await page.unroute(rpc);

    await page.goto('/security');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await snap('seguridad');
    await page.getByRole('button', { name: 'Mostrar el QR del sobre cifrado' }).click();
    await expect(page.getByRole('img', { name: /QR del sobre cifrado/ }).first()).toBeVisible();
    await snap('seguridad-qr');
    await page.goto('/security/lost-password-u');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await snap('perdi-la-password-u');
    expect(words).toHaveLength(5);
  } finally {
    await removeEnvelopeBackup(serializeEnvelope(envelope));
  }
});
