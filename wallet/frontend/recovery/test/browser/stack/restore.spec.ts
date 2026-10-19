// P19.T08 [F-KEY-10] contra los servicios reales, el fork y el Drive real: restaurar R en un dispositivo nuevo (contexto
// de navegador vacío). Desde el archivo, el QR (cámara simulada con un video del QR del sobre) o el Drive de Recovery,
// el sobre se abre con la Password R de siempre; desde las 17 palabras, R se re-cifra con una Password R nueva para la
// wallet de la PlatformSession RECOVERY. Siempre se verifica en Base que sea la recoveryKey vigente de la Safe: una
// clave que no lo es (o un backup de U) no se restaura. El sobre restaurado se puede recordar en el dispositivo.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { openRecoveryEnvelope, parseRecoveryEnvelope } from '../../../src/crypto/envelope.ts';
import { uploadRecoveryEnvelope } from '../../../src/drive/backup.ts';
import { encodeFrames } from '../../../src/qr/frames.ts';
import { answerGoogleConsent, removeRecoveryBackup, testDrive } from './helpers/drive.ts';
import { downloadedText } from './helpers/download.ts';
import { nodeArgon2, recoveryWords, sealRecovery, type SealedRecovery } from './helpers/envelope.ts';
import { activeWallet, type ActiveWallet } from './helpers/onboard.ts';
import { advanceRateLimitWindows } from './helpers/stack.ts';
import { writeQrVideo } from './helpers/qr.ts';
import { completeStepUp, login, writeDownPasswordR } from './helpers/ui.ts';

const VIDEO = resolve(import.meta.dirname, '../../../test-results/stack/qr-recovery-envelope.y4m');

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  },
});

let wallet: ActiveWallet;
let recovery: PrivateKeyAccount;
let recoveryKey: `0x${string}`;
let sealed: SealedRecovery;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  recoveryKey = generatePrivateKey();
  recovery = privateKeyToAccount(recoveryKey);
  wallet = await activeWallet('restore', recovery);
  sealed = await sealRecovery(recovery, recoveryKey, wallet.walletId);
  mkdirSync(dirname(VIDEO), { recursive: true });
  writeQrVideo(VIDEO, await encodeFrames(JSON.stringify(sealed.envelope)));
});

async function openAndVerify(page: Page): Promise<void> {
  await expect(page.getByText('Sobre cifrado de la clave R')).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Password R').fill(sealed.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Abrir el sobre' }).click();
  await page.getByLabel('Dirección de tu Safe (para verificar R en Base)').fill(wallet.safe);
  await page.getByRole('button', { name: 'Verificar en Base' }).click();
  await expect(page.locator(`[data-restored="${recovery.address}"]`)).toBeVisible({ timeout: 60_000 });
}

test('desde el archivo cifrado: Password R, verificación en Base y sobre recordado en el dispositivo', async ({
  page,
}) => {
  await page.goto('/restore');
  await page.getByRole('button', { name: 'Archivo cifrado' }).click();
  await page.getByLabel('Archivo del sobre cifrado (R.enc)').setInputFiles({
    name: `mtw-R-${wallet.walletId}.enc.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(sealed.file),
  });
  await openAndVerify(page);
  await page.getByRole('button', { name: 'Recordar el sobre cifrado en este dispositivo' }).click();
  await expect(page.getByText('Sobre cifrado recordado en este dispositivo.')).toBeVisible();
  // En otra pantalla, el desbloqueo ofrece el sobre recordado (sin volver a elegir el archivo).
  await page.getByRole('link', { name: 'MT Recovery, inicio' }).click();
  await page.getByRole('button', { name: 'Bloquear' }).click();
  await page.getByRole('link', { name: 'Rotaciones pendientes' }).click();
  await login(page, wallet.account.email);
  await expect(
    page.getByRole('button', {
      name: `Usar el sobre recordado de la clave R con la dirección ${recovery.address.slice(0, 10)}…`,
    }),
  ).toBeVisible();
});

test('desde el QR del sobre leído con la cámara', async ({ page }) => {
  await page.goto('/restore');
  await page.getByRole('button', { name: 'QR del sobre' }).click();
  await page.getByRole('button', { name: 'Leer el QR con la cámara' }).click();
  await openAndVerify(page);
});

test('desde las 17 palabras: Password R nueva, re-cifrado para la wallet y verificación en Base', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/restore');
  await page.getByRole('button', { name: '17 palabras' }).click();
  // Un backup que no es de R (otra R cualquiera) se lee pero no se restaura: no es la R vigente de la Safe.
  await page.getByLabel('Las 17 palabras, en orden').fill((await recoveryWords(generatePrivateKey())).join(' '));
  await page.getByRole('button', { name: 'Leer las palabras' }).click();
  await login(page, wallet.account.email);
  await completeStepUp(page, wallet.account.email);
  await writeDownPasswordR(page, 'Generar la Password R nueva', 'Verificar en Base y cifrar');
  await expect(page.getByText('Esta clave no es la clave de recuperación vigente de tu Safe')).toBeVisible({
    timeout: 60_000,
  });

  // Las palabras de la R vigente: se re-cifra con la Password R nueva (otro step-up: se adelanta la ventana de los
  // códigos por email de la cuenta, [B-RL]).
  advanceRateLimitWindows();
  await page.goto('/restore');
  await page.getByRole('button', { name: '17 palabras' }).click();
  await page.getByLabel('Las 17 palabras, en orden').fill((await recoveryWords(recoveryKey)).join(' '));
  await page.getByRole('button', { name: 'Leer las palabras' }).click();
  await expect(page.locator(`[data-address="${recovery.address}"]`).first()).toBeVisible();
  await completeStepUp(page, wallet.account.email);
  const fresh = await writeDownPasswordR(page, 'Generar la Password R nueva', 'Verificar en Base y cifrar');
  await expect(page.locator(`[data-restored="${recovery.address}"]`)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Es un sobre nuevo, cifrado con tu Password R nueva')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click(),
  ]);
  const envelope = parseRecoveryEnvelope(JSON.parse(await downloadedText(download)));
  expect(envelope).toMatchObject({ walletId: wallet.walletId, keyAddress: recovery.address });
  expect((await openRecoveryEnvelope(envelope, fresh.join(' '), nodeArgon2)).address).toBe(recovery.address);
});

test('un backup de U no se lee como R', async ({ page }) => {
  await page.goto('/restore');
  await page.getByRole('button', { name: '17 palabras' }).click();
  // Las palabras de U (vector de contracts/) llevan el rol U en el checksum.
  const vectors = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../vectors/wire/backup-words.json'), 'utf8'),
  ) as { backups: { role: string; words: string[] }[] };
  const userWords = vectors.backups.find((b) => b.role === 'U')?.words ?? [];
  expect(userWords).toHaveLength(17);
  await page.getByLabel('Las 17 palabras, en orden').fill(userWords.join(' '));
  await page.getByRole('button', { name: 'Leer las palabras' }).click();
  await expect(page.getByText(/no son un backup de R válido/)).toBeVisible();
});

test('desde el Drive de Recovery en un dispositivo nuevo (API real de Drive)', async ({ page }) => {
  test.setTimeout(300_000);
  await uploadRecoveryEnvelope(await testDrive(), sealed.envelope);
  try {
    await answerGoogleConsent(page);
    await page.goto('/restore');
    await page.getByRole('button', { name: 'Google Drive de Recovery' }).click();
    await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
    await expect(page.getByText('Google Drive conectado (carpeta privada de Recovery).')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/restore');
    await page.getByRole('button', { name: 'Buscar mis sobres en Drive' }).click();
    await page.locator(`[data-drive-backup="${wallet.walletId}"] button`).click();
    await openAndVerify(page);
  } finally {
    await removeRecoveryBackup(wallet.walletId);
  }
});
