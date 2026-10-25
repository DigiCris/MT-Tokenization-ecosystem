// P17.MAN (R-14): recorrido del onboarding completo contra los servicios reales con capturas de cada pantalla para el
// agente revisor (textos de advertencia): registro y olvido de contraseña de cuenta, conexión de Drive, step-up (pedido y
// código), Password U y su confirmación, sobre (con las opciones avanzadas abiertas), subida a Drive, backups
// independientes (archivo, QR y 17 palabras con su confirmación), alta de U y la activación de Recovery con la app
// Recovery real (segunda revisión): /enroll desde el enlace de ida con el secreto k del pedido, step-up, creación de R
// con la Password R y su confirmación, backups de R (archivo, QR estático y 17 palabras con su confirmación), envío y la
// pantalla final con la dirección en grupos. En la Wallet, la confirmación manual (la R no se muestra antes de
// confirmar; ningún grupo coincide, un error de tipeo y, al agotar los intentos, el pedido se cancela y se genera otro
// que obliga a crear otra R), la dirección confirmada a mano, la creación retomada en una pestaña recargada (avisa que
// Recovery va a crear otra R, y el primer pedido también) y el camino del enlace de regreso con k desde la pantalla de
// Recovery. Tercera revisión: el primer enrollment recuerda el sobre de R en ese dispositivo (la casilla viene marcada)
// y el último no, así las dos pantallas finales de Recovery muestran cada texto. Después, la creación de la Safe con sus
// mensajes de progreso, Seguridad (con el QR re-exportado) y "perdí mi Password U". Corre en cada navegador de
// MTW_BROWSERS y sólo con MTW_REVIEW_DIR (capturas en <dir>/onboarding/<navegador>/).
import { expect, test, type Page, type Route } from '@playwright/test';
import { serializeEnvelope, parseEnvelope } from '../../../../src/crypto/envelope.ts';
import {
  addressGroups,
  MANUAL_ABORT_TEXT,
  MANUAL_MISMATCH_TEXT,
  NEW_REQUEST_TEXT,
  RESUME_NEW_REQUEST_TEXT,
} from '../../../../src/recovery-activation/activation.ts';
import { recoveryRequest, typeRecoveryGroups, waitForManualConfirmation } from '../helpers/activation.ts';
import { answerGoogleConsent, removeEnvelopeBackup } from '../helpers/drive.ts';
import { nextCode } from '../helpers/mailpit.ts';
import { verifiedAccount } from '../helpers/onboard.ts';
import { randomAddress } from '../helpers/operate.ts';
import { enrollInRecovery, serveRecoveryApp, type RecoveryApp } from '../helpers/recovery-app.ts';
import { advanceRateLimitWindows, stack } from '../helpers/stack.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  writeDownAndConfirmBackupWords,
  writeDownAndConfirmPassword,
} from '../helpers/ui.ts';
import { reviewCamera } from './camera.ts';

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

/** Una dirección que no coincide con `address` en ningún grupo (cada carácter cambiado). */
function everyGroupDifferent(address: `0x${string}`): string[] {
  return addressGroups(address).map((group) => group.replace(/./g, (c) => (c.toLowerCase() === 'a' ? 'b' : 'a')));
}

let recoveryApp: RecoveryApp | null = null;

test.afterAll(() => {
  recoveryApp?.stop();
});

test('onboarding completo con capturas para la revisión de textos', async ({ page }, testInfo) => {
  test.setTimeout(1_200_000);
  const snap = reviewCamera(page, 'onboarding', testInfo.project.name);
  // La app Recovery real, compilada contra este stack (tarda: se hace antes de empezar a capturar).
  const app = await serveRecoveryApp();
  recoveryApp = app;
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
  const recovery = await page.context().newPage();
  try {
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('button', { name: 'Registrar', exact: true })).toBeVisible();
    await snap('registrar-u');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
    await expect(page.locator('[data-recovery-link]')).toBeVisible();
    await snap('activar-recovery');

    // Pedido 1, en la app Recovery real (otro dispositivo en la vida real): el enlace de ida con k abre /enroll; todas
    // las pantallas del enrollment, con los tres backups de R, hasta la dirección enviada en grupos.
    const first = await recoveryRequest(page);
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sentFirst = await enrollInRecovery(recovery, account, first.link, {
      snap: (name) => snap(name, recovery),
      allBackups: true,
    });
    expect(new URLSearchParams(sentFirst.returnLink.hash.slice(1)).get('k')).toBe(first.secret);

    // La Wallet pide copiar la dirección de Recovery y no la muestra.
    await page.bringToFront();
    await waitForManualConfirmation(page, sentFirst.recoveryKey);
    await snap('confirmar-r');
    // Lo que se tipeó no coincide en ningún grupo con lo que recibió la plataforma (R cambiada en el camino).
    await typeRecoveryGroups(page, everyGroupDifferent(sentFirst.recoveryKey));
    await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
    // Con los intentos que quedan, y generar un pedido nuevo como acción principal.
    await expect(
      page.getByText(/^No coincide ningún grupo: no parece un error de tipeo \(te quedan 2 intentos\)\./),
    ).toBeVisible();
    await expect(
      page.locator('[data-mismatch-groups]').getByRole('button', { name: 'Generar un pedido nuevo' }),
    ).toHaveClass('button');
    await snap('confirmar-r-no-coincide');
    // Un error de tipeo en dos grupos: cuáles revisar.
    const typo = addressGroups(sentFirst.recoveryKey).map((g, i) =>
      i === 1 || i === 4 ? (g === '0000' ? '1111' : '0000') : g,
    );
    await typeRecoveryGroups(page, typo);
    await expect(page.getByText(/revisá los grupos 2 y 5, y volvé a confirmar \(te queda 1 intento\)/)).toBeVisible();
    await snap('confirmar-r-error-de-tipeo');
    await typeRecoveryGroups(page, addressGroups(randomAddress()));
    await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
    await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
    await snap('confirmar-r-pedido-cancelado');
    await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
    await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
    await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
    await snap('activar-recovery-pedido-nuevo');

    // Pedido 2: Recovery crea otra R (sólo archivo) y la dirección se confirma a mano, como desde otro dispositivo.
    advanceRateLimitWindows();
    const second = await recoveryRequest(page);
    expect(second.enrollmentId).not.toBe(first.enrollmentId);
    const sentSecond = await enrollInRecovery(recovery, account, second.link);
    expect(sentSecond.recoveryKey).not.toBe(sentFirst.recoveryKey);
    await page.bringToFront();
    await waitForManualConfirmation(page, sentSecond.recoveryKey);
    await typeRecoveryGroups(page, addressGroups(sentSecond.recoveryKey));
    await expect(page.getByText('Dirección de tu clave R (confirmada):')).toBeVisible();
    await snap('confirmar-r-confirmada');

    // La pestaña se recarga antes de seguir: se retoma con el sobre y la Password U, y Activar Recovery pide otro. Como
    // ya hubo pedidos (la pestaña lo sabe y la plataforma tiene la R del pedido 2), avisa que Recovery va a crear otra R.
    advanceRateLimitWindows();
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toBeVisible();
    await expect(page.getByText(RESUME_NEW_REQUEST_TEXT)).toBeVisible();
    await snap('seguir-con-la-creacion');
    await page.getByRole('button', { name: 'Desde un archivo' }).click();
    await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
      name: 'mtw-U.enc.json',
      mimeType: 'application/json',
      buffer: Buffer.from(file),
    });
    await page.getByLabel('Password U').fill(words.join(' '));
    await page.getByRole('button', { name: 'Abrir el sobre' }).click();
    await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible({ timeout: 60_000 });
    await completeStepUp(page, account.email);
    await expect(page.locator('[data-recovery-link]')).toBeVisible();
    // El primer pedido después de recargar también avisa que Recovery va a crear otra R.
    await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
    await snap('activar-recovery-tras-recargar');

    // Pedido 3, el camino del enlace de regreso: «Volver a la Wallet» en Recovery abre la Wallet en esa pestaña, que le
    // pasa el pedido, la R y el k a la pestaña del pedido; ésta comprueba el k y la R, y sigue sola. Esta vez sin
    // recordar el sobre en el dispositivo: la pantalla final de Recovery lo dice.
    advanceRateLimitWindows();
    const third = await recoveryRequest(page);
    const sentThird = await enrollInRecovery(recovery, account, third.link, { remember: false });
    expect(new URLSearchParams(sentThird.returnLink.hash.slice(1)).get('k')).toBe(third.secret);
    await snap('recovery-regreso-direccion-enviada', recovery);
    await recovery.getByRole('link', { name: 'Volver a la Wallet' }).click();
    await expect(recovery.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
    expect(await recovery.evaluate(() => window.location.hash)).toBe('');
    await snap('regreso-a-la-wallet', recovery);
    await page.bringToFront();
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
    await recovery.close();
    app.stop();
    recoveryApp = null;
    await removeEnvelopeBackup(serializeEnvelope(envelope));
  }
});
