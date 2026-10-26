// P22.T03: la Wallet no habla con hosts fuera de su allowlist, no tiene violaciones de CSP ni de Trusted Types y no
// registra service workers. En el onboarding de U con Drive real, Google aparece sólo para Drive (la API y la pantalla de
// autorización, que responde el test) y nunca con una revocación; con una wallet activa desbloqueada, cada pantalla de
// operación y de Seguridad habla sólo con el propio origen, la API de la Wallet y el RPC propio.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { serializeEnvelope, parseEnvelope } from '../../../frontend/wallet/src/crypto/envelope.ts';
import { answerGoogleConsent, removeEnvelopeBackup } from '../../fixtures/wallet/drive.ts';
import { activeWallet, verifiedAccount } from '../../fixtures/wallet/onboard.ts';
import { stack, walletOrigin } from '../../fixtures/stack.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  openFromHome,
  openSecurity,
  unlockToHome,
  writeDownAndConfirmPassword,
} from '../../fixtures/wallet/ui.ts';
import { recordViolations } from '../../fixtures/wallet/violations.ts';

const GOOGLE_DRIVE = ['https://www.googleapis.com', 'https://accounts.google.com'];

/** Requests y websockets a orígenes fuera de `allowed`. */
function outside(page: Page, allowed: readonly string[]): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (!allowed.includes(new URL(request.url()).origin)) seen.push(request.url());
  });
  page.on('websocket', (socket) => seen.push(socket.url()));
  return seen;
}

async function serviceWorkers(page: Page, context: BrowserContext): Promise<number> {
  const registered = await page.evaluate(async () =>
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  return registered + context.serviceWorkers().length;
}

const own = () => [walletOrigin(), new URL(stack().urls.apiWallet).origin, new URL(stack().urls.anvil).origin];

test('onboarding de U con Drive: Google sólo para Drive, sin revocaciones, violaciones ni service workers', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  const external = outside(page, [...own(), ...GOOGLE_DRIVE]);
  const violations = await recordViolations(page);
  const account = await verifiedAccount('e2e-hosts-onboarding');
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(/\/onboarding$/);
  const consent = await answerGoogleConsent(page);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await completeStepUp(page, account.email);
  await writeDownAndConfirmPassword(page);
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();
  await page.getByRole('button', { name: 'Subir a Drive y verificar' }).click();
  await expect(page.getByText('Sobre subido a Drive y verificado.')).toBeVisible({ timeout: 60_000 });
  const file = await backupToFile(page);
  try {
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible({ timeout: 60_000 });
    expect(await violations()).toEqual([]);
    expect(await serviceWorkers(page, context)).toBe(0);
    expect(external).toEqual([]);
    expect(consent.revoked).toEqual([]);
  } finally {
    await removeEnvelopeBackup(serializeEnvelope(parseEnvelope(JSON.parse(file))));
  }
});

test('wallet activa: cada pantalla habla sólo con el propio origen, la API de la Wallet y el RPC propio', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('e2e-hosts-active');
  const external = outside(page, own());
  const violations = await recordViolations(page);
  await unlockToHome(page, wallet);
  for (const link of ['Enviar', 'Swap', 'Whitelist', 'Activos', 'Ver toda la actividad']) {
    await openFromHome(page, link);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
  }
  for (const link of [
    'Sesiones abiertas',
    'Verificación en dos pasos',
    'Rotaciones (pendientes, cancelar, ejecutar)',
    'Estado y reemplazo de tu clave de recuperación (R)',
    'Cambiar la Password U',
  ]) {
    await openSecurity(page, link);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
  }
  expect(await violations()).toEqual([]);
  expect(await serviceWorkers(page, context)).toBe(0);
  expect(external).toEqual([]);
});
