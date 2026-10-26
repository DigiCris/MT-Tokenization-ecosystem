// P22.T03, el lado de R: test de canario del enrollment en la app Recovery real (la Wallet arma el pedido por API).
// Después de crear R en el navegador con su Password R, subir el sobre al Drive real de Recovery, bajar el archivo,
// mostrar las 17 palabras y enviar la dirección, ni R (hex, base64 y base64url), ni la Password R, ni las 17 palabras
// aparecen en ningún request ni en ningún storage. Tampoco quedan guardados el token de la PlatformSession, el token
// CSRF, el access token de Drive ni material privado de la session key (un JWK con `d`): viven sólo en memoria.
import { expect, test } from '@playwright/test';
import { recoveryKeyToWords } from '../../../frontend/recovery/src/crypto/backup-words.ts';
import { decryptRecoveryKey, parseRecoveryEnvelope } from '../../../frontend/recovery/src/crypto/envelope.ts';
import { base64UrlToBytes } from '../../../frontend/recovery/src/crypto/encoding.ts';
import { deriveRoot, encryptionKeyFromRoot } from '../../../frontend/recovery/src/crypto/kdf.ts';
import { normalizePasswordR } from '../../../frontend/recovery/src/crypto/password.ts';
import { assertAbsent, captureRequests, storages, variants } from '../../fixtures/canary.ts';
import { downloadedText } from '../../fixtures/download.ts';
import { answerGoogleConsent, driveTestToken, removeRecoveryBackup } from '../../fixtures/recovery/drive.ts';
import { nodeArgon2, testWordlist } from '../../fixtures/recovery/envelope.ts';
import { onboardUntilEnrollment } from '../../fixtures/recovery/onboard.ts';
import { completeStepUp, login, writeDownPasswordR } from '../../fixtures/recovery/ui.ts';
import { recoveryOrigin } from '../../fixtures/stack.ts';

// En el E2E el baseURL es el de la Wallet: este test navega la app Recovery.
test.use({ baseURL: recoveryOrigin() });

test('enrollment de R con Drive: R, la Password R, las 17 palabras y los tokens no salen de la memoria', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  const state = await onboardUntilEnrollment('e2e-canary-r');
  const requests = captureRequests(page);
  const tokens: string[] = [];
  page.on('response', async (response) => {
    if (!/\/(platform-sessions\/(opaque|step-up)\/finish|auth\/csrf)$/.test(new URL(response.url()).pathname)) return;
    try {
      const body = (await response.json()) as { token?: string; csrfToken?: string };
      for (const value of [body.token, body.csrfToken]) if (value) tokens.push(value);
    } catch {
      // sin cuerpo JSON
    }
  });
  await answerGoogleConsent(page);
  const link = `/enroll#${new URLSearchParams({
    eid: state.enrollment.enrollmentId,
    n: state.enrollment.nonce,
    k: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  }).toString()}`;
  await page.goto(link);
  await login(page, state.account.email);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page.getByText('Google Drive conectado (carpeta privada de Recovery).')).toBeVisible();
  await completeStepUp(page, state.account.email);
  await page.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();
  const passwordWords = await writeDownPasswordR(page, 'Generar mi clave R', 'Confirmar y cifrar');
  await expect(page.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 60_000 });
  try {
    await page.getByRole('button', { name: 'Guardar el sobre cifrado en mi Drive' }).click();
    await expect(page.getByText('El sobre cifrado quedó en la carpeta privada de Recovery en tu Drive.')).toBeVisible({
      timeout: 60_000,
    });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click(),
    ]);
    const envelope = parseRecoveryEnvelope(JSON.parse(await downloadedText(download)));
    await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
    await expect(page.getByRole('list', { name: '17 palabras de tu clave R' }).locator('.words__word')).toHaveCount(17);
    await page.getByRole('button', { name: 'Ocultar las palabras' }).click();
    await page
      .getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password R al lado).', { exact: true })
      .check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Firmar y enviar' }).click();
    await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible({
      timeout: 60_000,
    });

    // R se abre acá, en Node, con la Password R anotada: es lo que el navegador nunca tiene que dejar salir.
    const wordlist = testWordlist();
    const root = await deriveRoot(
      normalizePasswordR(passwordWords.join(' '), wordlist),
      base64UrlToBytes(envelope.kdf.salt, 16),
      envelope.kdf,
      nodeArgon2,
    );
    const key = await decryptRecoveryKey(envelope, await encryptionKeyFromRoot(root));
    const backupWords = await recoveryKeyToWords(key, wordlist);
    const canaries = {
      'la clave R': variants(key),
      'la Password R': [passwordWords.join(' ')],
      'las 17 palabras de R': [backupWords.join(' ')],
    };
    for (const request of requests) {
      assertAbsent(`${request.url}\n${request.headers}\n${request.body}`, canaries, `un request a ${request.url}`);
    }
    expect(tokens.length).toBeGreaterThan(0);
    const stored = await storages(page, context);
    assertAbsent(
      stored,
      { ...canaries, 'un token de sesión o CSRF': tokens, 'el access token de Drive': [await driveTestToken()] },
      'los storages',
    );
    expect(stored).not.toMatch(/"d"\s*:\s*"/);
  } finally {
    await removeRecoveryBackup(state.walletId);
  }
});
