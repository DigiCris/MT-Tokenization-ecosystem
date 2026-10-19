// P19.T03 contra los servicios reales y el fork: Recovery recibe el pedido de la Wallet por el link (fragmento), la
// misma cuenta inicia sesión, verifica su identidad por email (PlatformSession ENROLLMENT) y registra la Enrollment
// Key. R interna: Password R de 5 palabras anotada y confirmada, sobre `R.enc` cifrado en el navegador, backup en el
// Drive de Recovery (API real) y en archivo, prueba de control EIP-712 y envío; R externa: una wallet EIP-6963 de prueba
// firma la prueba de control con eth_signTypedData_v4 (nunca eth_sign/personal_sign). En los dos casos la Wallet (por
// API) incorpora esa R, la Safe se despliega con R como recoveryKey del Guard y el link de regreso lleva la dirección.
import { expect, test } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from '../../../src/crypto/envelope.ts';
import { chain } from './helpers/chain.ts';
import { downloadedText } from './helpers/download.ts';
import { answerGoogleConsent, removeRecoveryBackup, testDrive } from './helpers/drive.ts';
import { finishOnboarding, onboardUntilEnrollment, type Onboarding } from './helpers/onboard.ts';
import { contract, walletOrigin } from './helpers/stack.ts';
import { installTestWallet } from './helpers/test-wallet.ts';
import { completeStepUp, login, writeDownPasswordR } from './helpers/ui.ts';

function enrollUrl(state: Onboarding): string {
  return `/enroll#${new URLSearchParams({ eid: state.enrollment.enrollmentId, n: state.enrollment.nonce }).toString()}`;
}

async function onchainRecoveryKey(safe: Address): Promise<Address> {
  const roles = await chain().readContract({
    address: contract('SecurityGuard'),
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [safe],
  });
  return getAddress(roles.recoveryKey);
}

test.describe.configure({ mode: 'serial' });

test('R interna: Password R, backups en Drive y archivo, prueba de control y Safe con R como recoveryKey', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const state = await onboardUntilEnrollment('enroll-internal');
  await answerGoogleConsent(page);
  await page.goto(enrollUrl(state));
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  await login(page, state.account.email);
  // El link sigue vigente después de iniciar sesión y Drive se conecta antes de tener nada en memoria.
  await expect(page.getByRole('heading', { name: 'Backup en tu Google Drive (opcional)' })).toBeVisible();
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page.getByText('Google Drive conectado (carpeta privada de Recovery).')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
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
    const file = await downloadedText(download);
    const envelope = parseRecoveryEnvelope(JSON.parse(file));
    expect(envelope).toMatchObject({ role: 'R', walletId: state.walletId });
    expect(download.suggestedFilename()).toBe(`mtw-R-${state.walletId}.enc.json`);
    // El de Drive es exactamente el mismo sobre (la serialización del archivo).
    const drive = await testDrive();
    const [stored] = await drive.list(`R.enc.${state.walletId}.json`);
    expect(new TextDecoder().decode(await drive.download(stored?.id ?? ''))).toBe(serializeRecoveryEnvelope(envelope));
    // Drive no cuenta como backup independiente de la plataforma: hace falta el archivo (o QR o palabras).
    await expect(page.getByText('Falta al menos un backup: archivo, QR o las 17 palabras.')).toBeVisible();
    await page.getByLabel('Guardé el archivo fuera de este dispositivo').check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Firmar y enviar' }).click();
    await expect(page.getByRole('heading', { name: 'Tu clave R quedó enviada' })).toBeVisible({ timeout: 60_000 });
    const sent = getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '');
    expect(sent).toBe(envelope.keyAddress);
    const link = new URL((await page.locator('[data-return-link]').getAttribute('data-return-link')) ?? '');
    expect(link.origin).toBe(walletOrigin());
    expect(decodeURIComponent(link.hash)).toContain(sent);
    expect(passwordWords).toHaveLength(5);

    const active = await finishOnboarding(state, null);
    expect(await onchainRecoveryKey(active.safe)).toBe(sent);
  } finally {
    await removeRecoveryBackup(state.walletId);
  }
});

test('R externa: la wallet EIP-6963 firma la prueba de control con eth_signTypedData_v4', async ({ page }) => {
  test.setTimeout(600_000);
  const external = privateKeyToAccount(generatePrivateKey());
  const log: string[] = [];
  await installTestWallet(page, external, { log });
  const state = await onboardUntilEnrollment('enroll-external');
  await page.goto(enrollUrl(state));
  await login(page, state.account.email);
  await completeStepUp(page, state.account.email);
  await page.getByRole('button', { name: 'Usar una wallet externa' }).click();
  await page.locator('[data-connector="test.mtw.wallet"]').click();
  await expect(page.getByText(`Clave R:`)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-address="${external.address}"]`).first()).toBeVisible();
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Tu clave R quedó enviada' })).toBeVisible({ timeout: 60_000 });
  expect(getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '')).toBe(
    external.address,
  );
  expect(log).toContain('eth_signTypedData_v4');
  expect(log.filter((m) => m === 'eth_sign' || m === 'personal_sign')).toEqual([]);

  const active = await finishOnboarding(state, external);
  expect(await onchainRecoveryKey(active.safe)).toBe(external.address);
});
