// P18.T01 contra los servicios reales: después del alta de U la app pide el enrollment y muestra el enlace para la app
// Recovery con el id y el nonce en el fragmento [F-LNK-01], también como QR; la app Recovery la hace Node por el listener
// de Recovery con una R real. Sin enlace de regreso, R se confirma con la comparación manual de la dirección completa,
// copiada de lo que muestra Recovery (la Wallet no muestra la R que recibió la plataforma hasta que coincide; un solo
// grupo distinto no confirma y dice qué grupo revisar); con el enlace de regreso en otra pestaña se confirma sola por
// BroadcastChannel y, si trae otra R que la que informa la plataforma, la activación se aborta [F-LNK-02]. Con R
// confirmada, la app verifica la asignación de S (atestación con la clave fijada, dirección calculada por la app) antes
// de ofrecer la firma de U.
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import { MANUAL_MISMATCH_TEXT } from '../../../src/recovery-activation/activation.ts';
import { confirmGroupsManually, onboardUpToRecovery, waitForManualConfirmation } from './helpers/activation.ts';
import { submitRecovery } from './helpers/onboard.ts';
import { randomAddress } from './helpers/operate.ts';
import { RECOVERY_ORIGIN } from './helpers/node-api.ts';
import { readCanvasQr } from './helpers/qr.ts';

test('enlace con el pedido en el fragmento y QR; R confirmada con la dirección completa; S verificada antes de firmar', async ({
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
  await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();

  const r = await submitRecovery(account, enrollment);
  // La Wallet no muestra la R que recibió la plataforma: hay que copiarla de Recovery.
  await waitForManualConfirmation(page, r.address);
  // Un grupo distinto (el sexto) no confirma: dice qué grupo revisar, sin revelar los caracteres esperados.
  await confirmGroupsManually(page, r.address, 5);
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  await expect(page.getByText(/revisá el grupo 6 y volvé a confirmar \(te quedan 2 intentos\)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await confirmGroupsManually(page, r.address);

  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  const summary = page.locator('[data-expected-safe]');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary.getByText('Dirección de la clave de la plataforma (S, verificada por esta app)')).toBeVisible();
  await expect(summary.getByText('Dirección de tu clave R (confirmada)')).toBeVisible();
  await expect(summary.locator(`[data-address="${getAddress(r.address)}"]`)).toBeVisible();
  await expect(page.getByText('Para mover fondos hacen falta 2 de esas 3 firmas.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar y crear la Safe' })).toBeVisible();
});

test('enlace de regreso de Recovery en otra pestaña: confirma R en la pestaña que la estaba esperando', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-link');
  const r = await submitRecovery(account, enrollment);
  await waitForManualConfirmation(page, r.address);
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollment.enrollmentId}&r=${r.address}`);
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  // El fragmento no queda en la URL ni en el historial.
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
});

test('enlace de regreso con otra R que la que informa la plataforma: el pedido se aborta y hay que generar otro', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-mismatch');
  const r = await submitRecovery(account, enrollment);
  await waitForManualConfirmation(page, r.address);
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollment.enrollmentId}&r=${randomAddress()}`);
  await expect(
    page.getByText(
      'La dirección que trae el enlace de Recovery no es la que recibió la plataforma: alguien pudo haberla cambiado en el camino. Se canceló este pedido.',
    ),
  ).toBeVisible();
  // Ese pedido ya no se puede confirmar a mano: sólo generar uno nuevo, con otro enrollment.
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
  const renewed = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  expect(new URLSearchParams(renewed.hash.slice(1)).get('eid')).not.toBe(enrollment.enrollmentId);
});
