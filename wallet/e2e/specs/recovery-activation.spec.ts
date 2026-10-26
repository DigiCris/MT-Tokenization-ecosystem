// P18.T01 contra los servicios reales: después del alta de U la app pide el enrollment y muestra el enlace para la app
// Recovery con el id, el nonce y el secreto k del pedido en el fragmento [F-LNK-01] (ADR-033), también como QR; la app
// Recovery la hace Node por el listener de Recovery con una R real. Sin enlace de regreso, R se confirma con la
// comparación manual de la dirección completa, copiada de lo que muestra Recovery (la Wallet no muestra la R que recibió
// la plataforma hasta que coincide; un solo grupo distinto no confirma y dice qué grupo revisar); con el enlace de
// regreso en otra pestaña (con el k del enlace de ida, como lo arma Recovery) se confirma sola por BroadcastChannel; si
// trae otra R que la que informa la plataforma, o no trae el k del pedido, la activación se aborta [F-LNK-02] y el
// pedido queda REJECTED en el backend con el motivo (N10). Con R confirmada, la app verifica la asignación de S
// (atestación con la clave fijada, dirección calculada por la app) antes de ofrecer la firma de U. Revisión de
// seguridad de ADR-033: la pestaña del enlace muestra el resultado real, y recargar la pestaña del pedido después de una
// comparación que no coincidió lo informa con el aviso keepalive (llega al backend real, con su preflight CORS).
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import {
  MANUAL_MISMATCH_TEXT,
  NEW_REQUEST_TEXT,
  RecoveryKeyMismatchError,
  ReturnLinkUnverifiedError,
} from '../../frontend/wallet/src/recovery-activation/activation.ts';
import {
  confirmGroupsManually,
  onboardUpToRecovery,
  recoveryRequest,
  returnLinkPath,
  waitForManualConfirmation,
} from '../fixtures/wallet/activation.ts';
import { submitRecovery } from '../fixtures/wallet/onboard.ts';
import { randomAddress } from '../fixtures/wallet/operate.ts';
import { RECOVERY_ORIGIN } from '../fixtures/wallet/node-api.ts';
import { readCanvasQr } from '../fixtures/wallet/qr.ts';

test('enlace con el pedido y k en el fragmento y QR; R confirmada con la dirección completa; S verificada antes de firmar', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { account, link, enrollment } = await onboardUpToRecovery(page, 'activation');
  expect(link.origin).toBe(RECOVERY_ORIGIN);
  expect(link.pathname).toBe('/enroll');
  expect(link.search).toBe('');
  expect(enrollment.enrollmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(enrollment.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  expect(enrollment.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await readCanvasQr(page.getByRole('img', { name: 'QR para abrir la app Recovery con este pedido' }))).toBe(
    link.toString(),
  );
  await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
  await expect(
    page.getByText(/^Este pedido vence a las \d{2}:\d{2}: si Recovery no informa la dirección antes/),
  ).toBeVisible();

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

test('enlace de regreso de Recovery en otra pestaña, con el k del pedido: confirma R en la pestaña que la esperaba', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-link');
  const r = await submitRecovery(account, enrollment);
  await waitForManualConfirmation(page, r.address);
  const other = await context.newPage();
  await other.goto(returnLinkPath(enrollment, r.address));
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  // La pestaña del enlace muestra el resultado real que informó la del pedido.
  await expect(other.locator('[data-return-outcome="confirmed"]')).toBeVisible();
  // El fragmento no queda en la URL ni en el historial.
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
});

test('enlace de regreso con otra R que la que informa la plataforma: el pedido se aborta, queda REJECTED y hay que generar otro', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-mismatch');
  const r = await submitRecovery(account, enrollment);
  await waitForManualConfirmation(page, r.address);
  const other = await context.newPage();
  await other.goto(returnLinkPath(enrollment, randomAddress()));
  await expect(page.getByText(new RecoveryKeyMismatchError().message)).toBeVisible();
  // Ese pedido ya no se puede confirmar a mano: sólo generar uno nuevo, con otro enrollment.
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  // El backend lo registró (N10): REJECTED con el motivo.
  await expect
    .poll(async () => (await account.api.getRecoveryEnrollment(enrollment.enrollmentId)) as unknown)
    .toMatchObject({ status: 'REJECTED', rejectionReason: 'RETURN_LINK_KEY_MISMATCH' });
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
  // Recovery va a crear otra R: qué destruir de la anterior (cuarta revisión de P17.MAN, hallazgo 1).
  await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
  const renewed = await recoveryRequest(page);
  expect(renewed.enrollmentId).not.toBe(enrollment.enrollmentId);
  expect(renewed.secret).not.toBe(enrollment.secret);
});

test('recargar la pestaña después de una comparación que no coincidió: el aviso keepalive llega y el pedido queda REJECTED', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-left');
  const r = await submitRecovery(account, enrollment);
  await confirmGroupsManually(page, r.address, 2);
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  // El aviso se firma apenas no coincide la comparación; pagehide lo manda con keepalive (con su preflight CORS).
  await page.waitForTimeout(1_000);
  await page.reload();
  await expect
    .poll(async () => (await account.api.getRecoveryEnrollment(enrollment.enrollmentId)) as unknown, {
      timeout: 30_000,
    })
    .toMatchObject({ status: 'REJECTED', rejectionReason: 'MANUAL_COMPARISON_FAILED' });
});

test('enlace de regreso sin el k del pedido (un backend comprometido conoce el pedido y R, no k): se aborta y queda REJECTED', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { account, enrollment } = await onboardUpToRecovery(page, 'activation-forged');
  const r = await submitRecovery(account, enrollment);
  await waitForManualConfirmation(page, r.address);
  // Trae la R que recibió la plataforma, pero no el k: no lo armó la app Recovery del usuario.
  const other = await context.newPage();
  await other.goto(returnLinkPath(enrollment, r.address, null));
  await expect(page.getByText(new ReturnLinkUnverifiedError().message)).toBeVisible();
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await expect
    .poll(async () => (await account.api.getRecoveryEnrollment(enrollment.enrollmentId)) as unknown)
    .toMatchObject({ status: 'REJECTED', rejectionReason: 'RETURN_LINK_UNVERIFIED' });
});
