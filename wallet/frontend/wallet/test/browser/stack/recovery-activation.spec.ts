// P18.T01 contra los servicios reales: después del alta de U la app pide el enrollment y muestra el link para la app
// Recovery con el id y el nonce en el fragmento [F-LNK-01], también como QR; la app Recovery la hace Node por el listener
// de Recovery con una R real. Sin link de regreso, R se confirma con la comparación manual de la dirección completa
// (un solo grupo distinto no confirma); con el link de regreso en otra pestaña se confirma sola por BroadcastChannel y,
// si trae otra R que la que informa la plataforma, la activación se aborta [F-LNK-02]. Con R confirmada, la app verifica
// la asignación de S (atestación con la clave fijada, dirección calculada por la app) antes de ofrecer la firma de U.
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import { confirmGroupsManually, onboardUpToRecovery } from './helpers/activation.ts';
import { submitRecovery } from './helpers/onboard.ts';
import { randomAddress } from './helpers/operate.ts';
import { RECOVERY_ORIGIN } from './helpers/node-api.ts';
import { readCanvasQr } from './helpers/qr.ts';

test('link con el pedido en el fragmento y QR; R confirmada con la dirección completa; S verificada antes de firmar', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { account, link, enrollment } = await onboardUpToRecovery(page, 'activation');
  expect(link.origin).toBe(RECOVERY_ORIGIN);
  expect(link.pathname).toBe('/enroll');
  expect(link.search).toBe('');
  expect(enrollment.enrollmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(enrollment.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await readCanvasQr(page.getByRole('img', { name: 'QR para abrir la app Recovery con este pedido' }))).toBe(
    link.toString(),
  );
  await expect(page.getByText('Esperando que Recovery envíe tu clave R…')).toBeVisible();

  const r = await submitRecovery(account, enrollment);
  await expect(page.locator(`[data-address="${getAddress(r.address)}"]`)).toBeVisible({ timeout: 60_000 });
  // Un grupo distinto (el sexto) no confirma: hay que copiar la dirección completa.
  await confirmGroupsManually(page, r.address, 5);
  await expect(
    page.getByText(
      'Los caracteres no coinciden con la clave que informa la plataforma: revisá la pantalla de Recovery.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await confirmGroupsManually(page, r.address);

  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  const summary = page.locator('[data-expected-safe]');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary.getByText(/Clave de la plataforma S \(atestada por el signer, shard .+\)/)).toBeVisible();
  await expect(summary.locator(`[data-address="${getAddress(r.address)}"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar y crear la Safe' })).toBeVisible();
});

test('link de regreso de Recovery en otra pestaña: confirma R en la pestaña que la estaba esperando', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-link');
  const r = await submitRecovery(account, enrollment);
  await expect(page.getByText('Recovery envió esta clave R:')).toBeVisible({ timeout: 60_000 });
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollment.enrollmentId}&r=${r.address}`);
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  // El fragmento no queda en la URL ni en el historial.
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
});

test('link de regreso con otra R que la que informa la plataforma: el pedido se aborta y hay que generar otro', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-mismatch');
  await submitRecovery(account, enrollment);
  await expect(page.getByText('Recovery envió esta clave R:')).toBeVisible({ timeout: 60_000 });
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollment.enrollmentId}&r=${randomAddress()}`);
  await expect(
    page.getByText('La clave que muestra Recovery no es la que informa la plataforma: se cancela la activación.'),
  ).toBeVisible();
  // Ese pedido ya no se puede confirmar a mano: sólo generar uno nuevo, con otro enrollment.
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.getByText('Esperando que Recovery envíe tu clave R…')).toBeVisible();
  const renewed = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  expect(new URLSearchParams(renewed.hash.slice(1)).get('eid')).not.toBe(enrollment.enrollmentId);
});
