// P19.MAN (WalletConnect real, automatizado): Recovery se empareja con una wallet headless (@reown/walletkit, versión
// fijada) a través del relay real de Reown con WALLETCONNECT_PROJECT_ID, usando el QR propio de la app (sin el modal).
// La wallet firma por WalletConnect la prueba de control del enrollment de R y, ya con la Safe activa, la propuesta de
// la S′ pedida por la plataforma y su cancelación (CancelRotation) en el fork; nunca se pide eth_sign ni personal_sign.
import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { safeState } from './helpers/chain.ts';
import { finishOnboarding, onboardUntilEnrollment, type ActiveWallet } from './helpers/onboard.ts';
import { addOperator } from './helpers/operators.ts';
import { readCanvasQr } from './helpers/qr.ts';
import { activeProposal, backendKnowsProposal, backendSettled } from './helpers/rotations.ts';
import { advanceRateLimitWindows } from './helpers/stack.ts';
import { completeStepUp, login, openFromHome } from './helpers/ui.ts';
import { headlessWallet, type HeadlessWallet } from './helpers/walletkit.ts';

test.describe.configure({ mode: 'serial' });

const account = privateKeyToAccount(generatePrivateKey());
let kit: HeadlessWallet;
let page: Page;
let wallet: ActiveWallet;

/** Elige WalletConnect, lee el QR propio de la app y la wallet headless se empareja por el relay. */
async function pairThroughQr(): Promise<void> {
  await page.locator('[data-connector="walletConnect"]').click();
  const qr = page.getByRole('img', { name: 'QR de WalletConnect para conectar tu wallet' });
  await expect(qr).toBeVisible({ timeout: 60_000 });
  const uri = await readCanvasQr(qr);
  expect(uri).toMatch(/^wc:[0-9a-f]{64}@2\?/);
  await kit.pair(uri);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  kit = await headlessWallet(account);
  page = await browser.newPage();
});

test.afterAll(async () => {
  await (page as Page | undefined)?.close();
  await (kit as HeadlessWallet | undefined)?.close();
});

test('enrollment: la wallet de WalletConnect firma la prueba de control y queda como R de la Safe', async () => {
  test.setTimeout(600_000);
  const state = await onboardUntilEnrollment('wc-live');
  await page.goto(
    `/enroll#${new URLSearchParams({ eid: state.enrollment.enrollmentId, n: state.enrollment.nonce }).toString()}`,
  );
  await login(page, state.account.email);
  await completeStepUp(page, state.account.email);
  await page.getByRole('button', { name: 'Usar una wallet externa' }).click();
  await pairThroughQr();
  await expect(page.locator(`[data-address="${account.address}"]`).first()).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible({
    timeout: 120_000,
  });
  expect(getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '')).toBe(
    account.address,
  );
  expect(kit.log).toContain('eth_signTypedData_v4');
  wallet = await finishOnboarding(state, account);
  expect((await safeState(wallet.safe)).roles.recoveryKey).toBe(account.address);
});

test('rotación pedida por la plataforma: R propone y cancela con su firma por WalletConnect', async () => {
  test.setTimeout(600_000);
  const operator = await addOperator('wc-ops');
  await operator.command(['executor:rotation-request', '--wallet', wallet.walletId, '--reason', 'MAINTENANCE']);
  // Cuarto código por email de la cuenta en pocos minutos ([B-RL]): se adelanta la ventana.
  advanceRateLimitWindows();
  await openFromHome(page, 'Rotaciones pendientes');
  await page.getByRole('button', { name: 'Mi clave R es una wallet externa' }).click();
  await pairThroughQr();
  await completeStepUp(page, wallet.account.email);
  await expect(page.locator('[data-s-request]')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Revisar y firmar la propuesta' }).click();
  await page.getByRole('button', { name: 'Firmar con tu wallet' }).click();
  await expect(page.locator('li[data-kind="S"]')).toBeVisible({ timeout: 240_000 });
  await backendKnowsProposal(wallet, 'S');
  await page.locator('li[data-kind="S"]').getByRole('button', { name: 'Cancelar con mi firma' }).click();
  await expect(page.getByText('Cancelación enviada: se confirma con el evento en Base.')).toBeVisible({
    timeout: 120_000,
  });
  await expect.poll(() => activeProposal(wallet.safe, 'S'), { timeout: 120_000 }).toMatch(/^0x0{64}$/);
  await backendSettled(wallet, 'S');
  expect(kit.log.filter((m) => m === 'eth_sign' || m === 'personal_sign')).toEqual([]);
});
