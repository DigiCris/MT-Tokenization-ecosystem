// Confirmación de la dirección de R ([F-LNK-02], ADR-033; hallazgos B2 de la primera revisión de P17.MAN y N2–N6 y N10
// de la segunda) contra `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts). Al retomar la creación
// con U ya registrada y activar Recovery: el QR y el enlace llevan el secreto k del pedido, la pantalla dice cuándo vence
// el pedido y no muestra la R que informa el backend antes de confirmarla (ni completa ni en grupos); una dirección que
// no coincide en ningún grupo recomienda no seguir, un error de tipeo dice qué grupos revisar sin revelar lo esperado,
// el tercer intento fallido aborta el pedido y se lo informa al backend (que después tampoco lo confirma un enlace de
// regreso), un pedido nuevo avisa que Recovery va a crear otra R, y pegar la dirección completa la reparte en los grupos.
// Con enlace de regreso en otra pestaña: con el k del pedido y la R del backend se confirma sola; sin k, con otro k o
// con otra R se cancela el pedido y se informa. Abierto en una pestaña que no tiene el pedido, no confirma nada y ofrece
// generar uno nuevo (y si no trae k, además lo informa).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { serializeEnvelope } from '../../src/crypto/envelope.ts';
import { addressOf, generatePrivateKey } from '../../src/crypto/keys.ts';
import { ONBOARDING_KEY_VERSION, LOST_U_AND_R_WARNING, sealUserKey } from '../../src/onboarding/user-key.ts';
import {
  addressGroups,
  BEFORE_NEW_REQUEST_TEXT,
  MANUAL_ABORT_TEXT,
  MANUAL_MISMATCH_TEXT,
  NEW_REQUEST_TEXT,
  RecoveryKeyMismatchError,
  RETURN_LINK_ELSEWHERE_TEXT,
  ReturnLinkUnverifiedError,
} from '../../src/recovery-activation/activation.ts';
import { deriveArgon2id } from '../../src/workers/argon2-protocol.ts';
import {
  accountRoutes,
  buildConfig,
  creatingWallet,
  enrollmentView,
  mockApi,
  onboardingStepUpRoutes,
  WALLET_ID,
  type ApiCall,
} from './helpers/mock-api.ts';

test.use({ timezoneId: 'America/Argentina/Buenos_Aires' });

/** Password U de prueba (ya normalizada): el sobre se arma acá, fuera del navegador. */
const PASSWORD_U = 'acorn violet marble tundra zebra';
/** Vencimiento de cada pedido que informa el backend simulado (15:25 UTC = 12:25 en Buenos Aires). */
const REQUEST_EXPIRES_AT = '2030-01-01T15:25:00.000Z';

const randomAddress = (): Address => addressOf(generatePrivateKey());

/** Una dirección que no coincide con `address` en ningún grupo (cada carácter cambiado). */
function everyGroupDifferent(address: Address): string[] {
  return addressGroups(address).map((group) => group.replace(/./g, (c) => (c.toLowerCase() === 'a' ? 'b' : 'a')));
}

interface Scenario {
  calls: ApiCall[];
  /** Pedidos creados, en orden. */
  enrollments: string[];
  /** Motivos con los que la Wallet rechazó cada pedido (POST /recovery/enrollments/{id}/reject). */
  rejected: { enrollmentId: string; reason: string }[];
  /** La R que va a "recibir" la plataforma para el pedido i. */
  reported: Address[];
  /** Pedidos para los que Recovery ya envió su R (hasta entonces la plataforma no la informa). */
  released: Set<number>;
}

/** Recovery envía la R de ese pedido (la plataforma empieza a informarla). */
function release(s: Scenario, enrollmentId: string): Address {
  const index = s.enrollments.indexOf(enrollmentId);
  const r = s.reported[index];
  if (index < 0 || r === undefined) throw new Error(`pedido desconocido ${enrollmentId}`);
  s.released.add(index);
  return r;
}

/** API simulada: wallet en CREATING con U registrada, step-up, pedidos de R y su rechazo. */
async function scenario(context: BrowserContext, baseURL: string | undefined, userKey: Address): Promise<Scenario> {
  const state: Scenario = { calls: [], enrollments: [], rejected: [], reported: [], released: new Set() };
  state.calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => creatingWallet()),
    ...onboardingStepUpRoutes('2030-01-01T15:10:00.000Z', () => WALLET_ID),
    {
      method: 'GET',
      path: /^\/wallets\/[^/]+\/deployment$/,
      handle: () => ({ body: { walletId: WALLET_ID, status: 'CREATING', U: userKey } }),
    },
    {
      method: 'POST',
      path: /^\/wallets\/[^/]+\/recovery\/enrollments$/,
      handle: () => {
        const enrollmentId = crypto.randomUUID();
        state.enrollments.push(enrollmentId);
        return {
          status: 201,
          body: {
            enrollmentId,
            nonce: `0x${'ab'.repeat(32)}`,
            expiresAt: REQUEST_EXPIRES_AT,
            status: 'REQUESTED',
            purpose: 'ONBOARDING',
          },
        };
      },
    },
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => {
        const index = state.enrollments.indexOf(id);
        return { body: enrollmentView(id, state.released.has(index) ? (state.reported[index] ?? null) : null) };
      },
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/reject$/,
      handle: (request, [id = '']) => {
        const { reason } = request.postDataJSON() as { reason: string };
        state.rejected.push({ enrollmentId: id, reason });
        return { body: { ...enrollmentView(id, null), status: 'REJECTED', rejectionReason: reason } };
      },
    },
  ]);
  return state;
}

/** Sobre de U armado en Node para la wallet de prueba. */
async function sealedUserKey() {
  const key = generatePrivateKey();
  const userKey = addressOf(key);
  const sealed = await sealUserKey(
    { key, address: userKey },
    PASSWORD_U,
    { platformId: buildConfig.platformId, walletId: WALLET_ID, keyVersion: ONBOARDING_KEY_VERSION },
    (input) => deriveArgon2id(input),
  );
  return { userKey, envelopeJson: serializeEnvelope(sealed.envelope) };
}

/** Pestaña recargada con U ya registrada: se retoma abriendo el sobre con la Password U y verificando la identidad. */
async function resume(page: Page, envelopeJson: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toBeVisible();
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(envelopeJson),
  });
  await page.getByLabel('Password U').fill(PASSWORD_U);
  await page.getByRole('button', { name: 'Abrir el sobre' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
}

/** El pedido que muestra la pantalla: id y secreto k del enlace de ida. */
async function shownRequest(page: Page): Promise<{ enrollmentId: string; secret: string }> {
  const link = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  const fragment = new URLSearchParams(link.hash.slice(1));
  return { enrollmentId: fragment.get('eid') ?? '', secret: fragment.get('k') ?? '' };
}

/** La R que recibió la plataforma no aparece en la página: ni la dirección completa ni dos grupos seguidos. */
async function expectNotShown(page: Page, reported: Address): Promise<void> {
  await expect(page.locator(`[data-address="${reported}"]`)).toHaveCount(0);
  const html = (await page.content()).toLowerCase();
  expect(html).not.toContain(reported.slice(2).toLowerCase());
  const groups = addressGroups(reported).map((g) => g.toLowerCase());
  for (let i = 0; i + 1 < groups.length; i++) expect(html).not.toContain(`${groups[i] ?? ''} ${groups[i + 1] ?? ''}`);
}

/** Lo que el usuario copia de la pantalla de Recovery, grupo por grupo, y la confirmación. */
async function typeGroups(page: Page, groups: readonly string[]): Promise<void> {
  for (let i = 0; i < groups.length; i++) {
    await page.getByLabel(`Grupo ${String(i + 1)} de 10`, { exact: true }).fill(groups[i] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar la dirección de R' }).click();
}

/** Abre el enlace de regreso en otra pestaña (como el `<a>` de Recovery) y espera a que la del pedido lo tome. */
async function openReturnLink(context: BrowserContext, fragment: Record<string, string>): Promise<void> {
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#${new URLSearchParams(fragment).toString()}`);
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  // El fragmento no queda en la URL ni en el historial.
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  await other.close();
}

test('manual: la R no se muestra; ningún grupo, tipeo y 3 intentos; el aborto se informa; pedido nuevo y pegado', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  s.reported = [randomAddress(), randomAddress()];

  await page.goto('/onboarding');
  await resume(page, envelopeJson);

  // Activar Recovery: el QR recomendado, qué no viaja a servidores, cuándo vence el pedido y qué pasa si se pierden U y R.
  const step = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Activar Recovery' }) });
  await expect(step).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Recovery');
  await expect(step.getByText(LOST_U_AND_R_WARNING)).toBeVisible();
  await expect(step.getByText(/^Te recomendamos crear tu clave R en otro dispositivo, como tu celular/)).toBeVisible();
  await expect(step.getByText(/Si mandás el enlace por chat o por email, sí pasa por esos servicios/)).toBeVisible();
  await expect(
    step.getByText(
      'Este pedido vence a las 12:25: si Recovery no informa la dirección antes, vas a tener que generar otro.',
    ),
  ).toBeVisible();
  await expect(step.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
  // El enlace de ida lleva el secreto del pedido; es el primero, así que todavía no hay aviso de "otra R".
  const first = await shownRequest(page);
  expect(first.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  await expect(page.getByText(NEW_REQUEST_TEXT)).toHaveCount(0);

  // Recovery informa R: la Wallet pide copiarla de Recovery y no la muestra (N3).
  const firstR = release(s, first.enrollmentId);
  const confirm = page.getByRole('button', { name: 'Confirmar la dirección de R' });
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await expect(
    step.getByText(
      'Si no, copiá la dirección que muestra la app Recovery (acá no la mostramos a propósito). Sirve para comprobar que nadie la cambió en el camino; da igual mayúsculas o minúsculas.',
      { exact: false },
    ),
  ).toBeVisible();
  await expectNotShown(page, firstR);

  // 1) Recovery muestra otra dirección (la R cambió en el camino): ningún grupo coincide, no parece un error de tipeo.
  await typeGroups(page, everyGroupDifferent(firstR));
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  await expect(
    page.getByText(
      'No coincide ningún grupo: no parece un error de tipeo. No sigas con este pedido: generá uno nuevo.',
    ),
  ).toBeVisible();
  await expect(page.getByText(BEFORE_NEW_REQUEST_TEXT)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await expectNotShown(page, firstR);

  // 2) Un error de tipeo en dos grupos: dice cuáles revisar (sin doble «y», N4), sin revelar lo esperado.
  const typo = addressGroups(firstR).map((g, i) => (i === 1 || i === 4 ? (g === '0000' ? '1111' : '0000') : g));
  await typeGroups(page, typo);
  await expect(
    page.getByText('Si te equivocaste al copiar, revisá los grupos 2 y 5, y volvé a confirmar (te queda 1 intento).'),
  ).toBeVisible();
  await expect(page.getByLabel('Grupo 2 de 10', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Grupo 3 de 10', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Continuar' })).toHaveCount(0);
  expect(s.rejected).toEqual([]);

  // 3) El tercer intento fallido aborta el pedido y se lo informa al backend (N10): sólo queda generar otro.
  await typeGroups(page, addressGroups(randomAddress()));
  await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expectNotShown(page, firstR);
  await expect
    .poll(() => s.rejected)
    .toEqual([{ enrollmentId: first.enrollmentId, reason: 'MANUAL_COMPARISON_FAILED' }]);
  // Abortado, tampoco lo confirma un enlace de regreso (ni con la R que recibió la plataforma), y no se informa de nuevo.
  const before = s.calls.length;
  await openReturnLink(context, { eid: first.enrollmentId, r: firstR });
  await page.waitForTimeout(500);
  expect(s.calls.slice(before).filter((c) => c.method === 'GET' && c.path.startsWith('/recovery/'))).toEqual([]);
  expect(s.rejected).toHaveLength(1);
  await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);

  // 4) Pedido nuevo: avisa que Recovery va a crear otra R (N5); pegar la dirección completa en el primer grupo la
  // reparte en los 10, y la dirección correcta (en minúsculas) confirma y recién ahí se muestra.
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
  const second = await shownRequest(page);
  expect(second.enrollmentId).not.toBe(first.enrollmentId);
  expect(second.secret).not.toBe(first.secret);
  const secondR = release(s, second.enrollmentId);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  expect(s.enrollments).toHaveLength(2);
  await expectNotShown(page, secondR);
  const firstGroup = page.getByLabel('Grupo 1 de 10', { exact: true });
  await firstGroup.focus();
  await firstGroup.evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData('text', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, secondR.toLowerCase());
  for (const [i, group] of addressGroups(secondR).entries()) {
    await expect(page.getByLabel(`Grupo ${String(i + 1)} de 10`, { exact: true })).toHaveValue(group.toLowerCase());
  }
  await confirm.click();
  const confirmed = page.getByRole('status').filter({ hasText: 'Dirección de tu clave R (confirmada):' });
  await expect(confirmed.locator(`[data-address="${secondR}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparar la Safe' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Safe');
  expect(s.rejected).toHaveLength(1);
  // k nunca viajó a la API.
  for (const secret of [first.secret, second.secret]) {
    expect(s.calls.filter((c) => `${c.path} ${c.body ?? ''}`.includes(secret))).toEqual([]);
  }
});

test('enlace de regreso en otra pestaña: con el k del pedido se confirma sola; sin k, con otro k o con otra R se cancela y se informa', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  s.reported = [randomAddress(), randomAddress(), randomAddress(), randomAddress()];
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const confirm = page.getByRole('button', { name: 'Confirmar la dirección de R' });
  const unverified = new ReturnLinkUnverifiedError().message;

  // 1) Sin k: no lo armó la app Recovery (aunque traiga la R que recibió la plataforma).
  const noSecret = await shownRequest(page);
  const firstR = release(s, noSecret.enrollmentId);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: noSecret.enrollmentId, r: firstR });
  await expect(page.getByText(unverified)).toBeVisible();
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expect(page.getByText(BEFORE_NEW_REQUEST_TEXT)).toBeVisible();
  await expect
    .poll(() => s.rejected)
    .toEqual([{ enrollmentId: noSecret.enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' }]);

  // 2) Con otro k: lo mismo.
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const otherSecret = await shownRequest(page);
  const secondR = release(s, otherSecret.enrollmentId);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, {
    eid: otherSecret.enrollmentId,
    r: secondR,
    k: `${otherSecret.secret.slice(0, 21)}${otherSecret.secret.endsWith('A') ? 'B' : 'A'}`,
  });
  await expect(page.getByText(unverified)).toBeVisible();
  await expect
    .poll(() => s.rejected.at(-1))
    .toEqual({ enrollmentId: otherSecret.enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' });

  // 3) Con el k del pedido pero otra R que la que recibió la plataforma: se cancela (la R cambió en el camino).
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const otherR = await shownRequest(page);
  release(s, otherR.enrollmentId);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: otherR.enrollmentId, r: randomAddress(), k: otherR.secret });
  await expect(page.getByText(new RecoveryKeyMismatchError().message)).toBeVisible();
  await expect
    .poll(() => s.rejected.at(-1))
    .toEqual({ enrollmentId: otherR.enrollmentId, reason: 'RETURN_LINK_KEY_MISMATCH' });
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);

  // 4) Con el k del pedido y la R del backend: se confirma sola, sin tipear nada.
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const good = await shownRequest(page);
  const goodR = release(s, good.enrollmentId);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: good.enrollmentId, r: goodR, k: good.secret });
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  expect(s.rejected).toHaveLength(3);
  expect(s.enrollments).toHaveLength(4);
});

test('enlace de regreso abierto en una pestaña sin el pedido: no confirma, ofrece un pedido nuevo y, sin k, lo informa', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  const enrollmentId = crypto.randomUUID();
  const r = randomAddress();

  // Con k: esta pestaña no conoce el secreto del pedido (vive sólo en la pestaña que lo generó, que ya no está).
  await page.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}&k=q1Zs-0bM4_Lr8xWp2cYtNg`);
  await resume(page, envelopeJson);
  await expect(page.getByRole('heading', { name: 'Volviste desde la app Recovery' })).toBeVisible();
  await expect(page.getByText(RETURN_LINK_ELSEWHERE_TEXT)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirmar la dirección de R' })).toHaveCount(0);
  await expect(page.locator(`[data-address="${r}"]`)).toHaveCount(0);
  expect(s.rejected).toEqual([]);
  // «Generar un pedido nuevo» sigue con el paso normal: pedido nuevo con su QR (N6).
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
  expect(s.enrollments).toHaveLength(1);

  // Sin k: además, no lo armó la app Recovery: se cancela ese pedido y se informa.
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}`);
  await resume(other, envelopeJson);
  await expect(other.getByText(new ReturnLinkUnverifiedError().message)).toBeVisible();
  await expect(other.getByRole('button', { name: 'Confirmar la dirección de R' })).toHaveCount(0);
  await expect.poll(() => s.rejected).toEqual([{ enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' }]);
  await other.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(other.locator('[data-recovery-link]')).toBeVisible();
});
