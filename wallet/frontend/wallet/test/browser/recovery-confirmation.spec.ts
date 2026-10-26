// Confirmación de la dirección de R ([F-LNK-02], ADR-033; hallazgos B2 de la primera revisión de P17.MAN, N2–N6 y N10
// de la segunda, y la revisión de seguridad de ADR-033) contra `vite preview`, con la API simulada
// (test/browser/helpers/mock-api.ts). Al retomar la creación con U ya registrada y activar Recovery: el QR y el enlace
// llevan el secreto k del pedido, la pantalla dice cuándo vence el pedido y no muestra la R que informa el backend antes
// de confirmarla (ni completa ni en grupos); una dirección que no coincide en ningún grupo recomienda no seguir, un error
// de tipeo dice qué grupos revisar sin revelar lo esperado, el tercer intento fallido aborta el pedido y se lo informa
// al backend (que después tampoco lo confirma un enlace de regreso, ni con el k y la R correctos), un pedido nuevo avisa
// que Recovery va a crear otra R, y pegar la dirección completa la reparte en los grupos. Con enlace de regreso en otra
// pestaña: con el k del pedido y la R del backend se confirma sola; sin k, con otro k o con otra R se cancela el pedido y
// se informa, y la pestaña del enlace muestra el resultado real. Con el k del pedido, una respuesta inconsistente de la
// plataforma (otro estado, otro pedido, un error con una dirección en el texto) también aborta, y nada de lo que
// responde aparece en pantalla. Un enlace viejo o el de antes de recargar la pestaña no confirman nada. Abierto en una
// pestaña sin el pedido, la explicación sale enseguida y, sin k, el aviso va con la sesión del propósito del pedido. Un
// pedido cancelado o reemplazado desde otra pestaña lo ve la del pedido (también al comparar), y dejar el pedido después
// de una comparación que no coincidió lo aborta e informa (al salir de la pantalla y al recargar la pestaña). El k nunca
// viaja a la API: ni en las rutas, ni en los cuerpos (también los de los rechazos), ni en los headers. Tercera revisión
// de P17.MAN: el «0x» va fijo antes del Grupo 1 y uno tipeado ahí se ignora; sin casi ningún grupo coincidente se dicen
// los intentos que quedan y generar otro pedido es la acción principal; retomar la creación después de un pedido (en
// la misma pestaña o con una R ya enviada según la plataforma) avisa que Recovery va a crear otra R, y el primer pedido
// lo repite; y si la verificación venció, «Generar un pedido nuevo» pide el step-up ahí mismo en lugar de fallar.
// Cuarta revisión: un pedido que la plataforma crea con otro propósito que el de la pantalla no se usa (ni su QR ni su
// enlace, con un texto local), y «0x» más el primer grupo pegado en el Grupo 1 deja el grupo entero.
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
  POLL_ERROR_TEXT,
  purposeMismatchText,
  RecoveryKeyMismatchError,
  RESUME_NEW_REQUEST_TEXT,
  RETURN_LINK_ELSEWHERE_TEXT,
  ReturnLinkUnverifiedError,
  SESSION_EXPIRED_TEXT,
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
  type MockResponse,
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
  /** Respuesta forzada del GET de un pedido (una plataforma inconsistente o que lo canceló desde otro lado). */
  view: Map<string, MockResponse>;
  /** Respuesta forzada del alta de un pedido. */
  create: MockResponse | null;
  /** La R que informa `GET /wallets/{id}/deployment` (la de un pedido anterior ya enviado), o null. */
  deployedR: Address | null;
  /** Cuánto dura la PlatformSession del próximo step-up. */
  sessionMs: number;
}

/** Recovery envía la R de ese pedido (la plataforma empieza a informarla). */
function release(s: Scenario, enrollmentId: string): Address {
  const index = s.enrollments.indexOf(enrollmentId);
  const r = s.reported[index];
  if (index < 0 || r === undefined) throw new Error(`pedido desconocido ${enrollmentId}`);
  s.released.add(index);
  return r;
}

/** Un error de la plataforma como lo armaría un backend comprometido: un título y un detalle con lo que quiera. */
function problemResponse(status: number, code: string, title: string, detail: string): MockResponse {
  return { status, body: { type: 'about:blank', title, status, code, detail, requestId: 'r-1' } };
}

/** API simulada: wallet en CREATING con U registrada, step-up, pedidos de R y su rechazo. */
async function scenario(context: BrowserContext, baseURL: string | undefined, userKey: Address): Promise<Scenario> {
  const state: Scenario = {
    calls: [],
    enrollments: [],
    rejected: [],
    reported: [],
    released: new Set(),
    view: new Map(),
    create: null,
    deployedR: null,
    sessionMs: 15 * 60_000,
  };
  state.calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => creatingWallet()),
    ...onboardingStepUpRoutes(
      '2030-01-01T15:10:00.000Z',
      () => WALLET_ID,
      () => state.sessionMs,
    ),
    {
      method: 'GET',
      path: /^\/wallets\/[^/]+\/deployment$/,
      handle: () => ({ body: { walletId: WALLET_ID, status: 'CREATING', U: userKey, R: state.deployedR } }),
    },
    {
      method: 'POST',
      path: /^\/wallets\/[^/]+\/recovery\/enrollments$/,
      handle: () => {
        if (state.create !== null) return state.create;
        const enrollmentId = crypto.randomUUID();
        state.enrollments.push(enrollmentId);
        state.reported.push(randomAddress());
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
        const forced = state.view.get(id);
        if (forced !== undefined) return forced;
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

/** El step-up con el código del email (la API simulada lo acepta). */
async function stepUp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
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
  await stepUp(page);
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

type Outcome = 'confirmed' | 'aborted' | 'retry' | 'none';

/**
 * Abre el enlace de regreso en otra pestaña (como el `<a>` de Recovery) y devuelve esa pestaña cuando muestra el
 * resultado que informó la del pedido ('none': ninguna lo tomó y lo explica ella misma).
 */
async function openReturnLink(context: BrowserContext, fragment: Record<string, string>, outcome: Outcome) {
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#${new URLSearchParams(fragment).toString()}`);
  if (outcome === 'none') {
    await expect(other.getByRole('heading', { name: 'Volviste desde la app Recovery' })).toBeVisible();
  } else {
    await expect(other.locator(`[data-return-outcome="${outcome}"]`)).toBeVisible();
  }
  // El fragmento no queda en la URL ni en el historial.
  expect(await other.evaluate(() => window.location.hash)).toBe('');
  return other;
}

/** Ningún pedido a la API lleva estos secretos: ni en la ruta, ni en el cuerpo, ni en los headers. */
function expectSecretsNeverSent(calls: readonly ApiCall[], secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const leaked = calls.filter((c) => `${c.path} ${c.body ?? ''} ${JSON.stringify(c.headers)}`.includes(secret));
    expect(leaked).toEqual([]);
  }
}

const step = (page: Page) =>
  page.locator('article').filter({ has: page.getByRole('heading', { name: 'Activar Recovery' }) });
const confirmButton = (page: Page) => page.getByRole('button', { name: 'Confirmar la dirección de R' });

test('manual: la R no se muestra; ningún grupo, tipeo y 3 intentos; el aborto se informa; pedido nuevo y pegado', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);

  await page.goto('/onboarding');
  await resume(page, envelopeJson);

  // Activar Recovery: el QR recomendado, qué no viaja a servidores, cuándo vence el pedido y qué pasa si se pierden U y R.
  await expect(step(page)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Recovery');
  await expect(step(page).getByText(LOST_U_AND_R_WARNING)).toBeVisible();
  await expect(
    step(page).getByText(/^Te recomendamos crear tu clave R en otro dispositivo, como tu celular/),
  ).toBeVisible();
  await expect(
    step(page).getByText(/Si mandás el enlace por chat o por email, sí pasa por esos servicios/),
  ).toBeVisible();
  await expect(
    step(page).getByText(
      'Este pedido vence a las 12:25: si Recovery no informa la dirección antes, vas a tener que generar otro.',
    ),
  ).toBeVisible();
  await expect(step(page).getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();
  // El enlace de ida lleva el secreto del pedido; es el primero (ni esta pestaña ni la plataforma saben de otro), así
  // que no hay aviso de "otra R".
  const first = await shownRequest(page);
  expect(first.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  await expect(page.getByText(NEW_REQUEST_TEXT)).toHaveCount(0);
  await expect(page.getByText(RESUME_NEW_REQUEST_TEXT)).toHaveCount(0);

  // Recovery informa R: la Wallet pide copiarla de Recovery y no la muestra (N3).
  const firstR = release(s, first.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(
    step(page).getByText(
      'Si no, copiá la dirección que muestra la app Recovery (acá no la mostramos a propósito). Sirve para comprobar que nadie la cambió en el camino; da igual mayúsculas o minúsculas.',
      { exact: false },
    ),
  ).toBeVisible();
  await expectNotShown(page, firstR);
  // Los 10 grupos son los que siguen al «0x», que va fijo antes del Grupo 1 (hallazgo 5).
  await expect(
    step(page).getByText(/Copiá los 10 grupos de 4 caracteres que siguen al «0x», uno en cada campo/),
  ).toBeVisible();
  const prefix = step(page).locator('[data-prefix="0x"]');
  await expect(prefix).toHaveText('0x');
  await expect(prefix).toHaveCount(1);
  const prefixBox = await prefix.boundingBox();
  const groupOneBox = await page.getByLabel('Grupo 1 de 10', { exact: true }).boundingBox();
  expect(prefixBox && groupOneBox && prefixBox.x + prefixBox.width <= groupOneBox.x).toBe(true);

  // 1) Recovery muestra otra dirección (la R cambió en el camino): ningún grupo coincide, no parece un error de tipeo.
  // Se dicen los intentos que quedan y generar un pedido nuevo pasa a ser la acción principal (hallazgo 6).
  await typeGroups(page, everyGroupDifferent(firstR));
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  await expect(
    page.getByText(
      'No coincide ningún grupo: no parece un error de tipeo (te quedan 2 intentos). No sigas con este pedido: generá uno nuevo.',
    ),
  ).toBeVisible();
  await expect(page.getByText(BEFORE_NEW_REQUEST_TEXT)).toBeVisible();
  const startOver = page.locator('[data-mismatch-groups]').getByRole('button', { name: 'Generar un pedido nuevo' });
  await expect(startOver).toHaveClass('button');
  await expect(confirmButton(page)).toHaveClass('button button--secondary');
  await expect(page.getByRole('button', { name: 'Continuar' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await expectNotShown(page, firstR);

  // 2) Un error de tipeo en dos grupos: dice cuáles revisar (sin doble «y», N4), sin revelar lo esperado.
  const typo = addressGroups(firstR).map((g, i) => (i === 1 || i === 4 ? (g === '0000' ? '1111' : '0000') : g));
  await typeGroups(page, typo);
  await expect(
    page.getByText('Si te equivocaste al copiar, revisá los grupos 2 y 5, y volvé a confirmar (te queda 1 intento).'),
  ).toBeVisible();
  // Con un error de tipeo, lo principal vuelve a ser revisar y confirmar.
  await expect(startOver).toHaveClass('button button--secondary');
  await expect(confirmButton(page)).toHaveClass('button');
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
  // Abortado, tampoco lo confirma un enlace de regreso: ni sin k ni con el k y la R correctos (que la pestaña del enlace
  // vea que se canceló), sin consultar a la plataforma y sin informarlo de nuevo.
  const before = s.calls.length;
  await openReturnLink(context, { eid: first.enrollmentId, r: firstR }, 'aborted');
  await openReturnLink(context, { eid: first.enrollmentId, r: firstR, k: first.secret }, 'aborted');
  expect(s.calls.slice(before).filter((c) => c.path.startsWith(`/recovery/enrollments/${first.enrollmentId}`))).toEqual(
    [],
  );
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
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  expect(s.enrollments).toHaveLength(2);
  await expectNotShown(page, secondR);
  const firstGroup = page.getByLabel('Grupo 1 de 10', { exact: true });
  // Un «0x» tipeado al principio del Grupo 1 se ignora: no corre los grupos (hallazgo 5).
  const secondGroups = addressGroups(secondR);
  await firstGroup.pressSequentially(`0x${secondGroups[0] ?? ''}`);
  await expect(firstGroup).toHaveValue(secondGroups[0] ?? '');
  await firstGroup.fill('');
  await firstGroup.focus();
  await firstGroup.evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData('text', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, secondR.toLowerCase());
  for (const [i, group] of addressGroups(secondR).entries()) {
    await expect(page.getByLabel(`Grupo ${String(i + 1)} de 10`, { exact: true })).toHaveValue(group.toLowerCase());
  }
  // La comparación vuelve a leer el pedido antes de aceptarse (BAJO 7).
  const reads = s.calls.length;
  await confirmButton(page).click();
  const confirmed = page.getByRole('status').filter({ hasText: 'Dirección de tu clave R (confirmada):' });
  await expect(confirmed.locator(`[data-address="${secondR}"]`)).toBeVisible();
  expect(
    s.calls.slice(reads).some((c) => c.method === 'GET' && c.path === `/recovery/enrollments/${second.enrollmentId}`),
  ).toBe(true);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparar la Safe' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Safe');
  expect(s.rejected).toHaveLength(1);
  // k nunca viajó a la API.
  expectSecretsNeverSent(s.calls, [first.secret, second.secret]);
});

test('enlace de regreso en otra pestaña: con el k del pedido se confirma sola; sin k, con otro k o con otra R se cancela, se informa y la pestaña del enlace lo dice', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const unverified = new ReturnLinkUnverifiedError().message;

  // 1) Sin k: no lo armó la app Recovery (aunque traiga la R que recibió la plataforma).
  const noSecret = await shownRequest(page);
  const firstR = release(s, noSecret.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  const forgedTab = await openReturnLink(context, { eid: noSecret.enrollmentId, r: firstR }, 'aborted');
  await expect(forgedTab.getByText(/no aceptó este enlace y canceló el pedido/)).toBeVisible();
  await expect(forgedTab.getByText(/^Listo/)).toHaveCount(0);
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
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await openReturnLink(
    context,
    {
      eid: otherSecret.enrollmentId,
      r: secondR,
      k: `${otherSecret.secret.slice(0, 21)}${otherSecret.secret.endsWith('A') ? 'B' : 'A'}`,
    },
    'aborted',
  );
  await expect(page.getByText(unverified)).toBeVisible();
  await expect
    .poll(() => s.rejected.at(-1))
    .toEqual({ enrollmentId: otherSecret.enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' });

  // 3) Con el k del pedido pero otra R que la que recibió la plataforma: se cancela (la R cambió en el camino).
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const otherR = await shownRequest(page);
  release(s, otherR.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: otherR.enrollmentId, r: randomAddress(), k: otherR.secret }, 'aborted');
  await expect(page.getByText(new RecoveryKeyMismatchError().message)).toBeVisible();
  await expect
    .poll(() => s.rejected.at(-1))
    .toEqual({ enrollmentId: otherR.enrollmentId, reason: 'RETURN_LINK_KEY_MISMATCH' });
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);

  // 4) Con el k del pedido y la R del backend: se confirma sola, sin tipear nada, y la pestaña del enlace dice «Listo».
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const good = await shownRequest(page);
  const goodR = release(s, good.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  const goodTab = await openReturnLink(context, { eid: good.enrollmentId, r: goodR, k: good.secret }, 'confirmed');
  await expect(goodTab.getByText(/^Listo: la dirección de tu clave R quedó confirmada/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  expect(s.rejected).toHaveLength(3);
  expect(s.enrollments).toHaveLength(4);
  // Ni las consultas, ni los rechazos (POST /reject), ni sus headers llevaron un k.
  expect(s.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reject'))).toHaveLength(3);
  expectSecretsNeverSent(s.calls, [noSecret.secret, otherSecret.secret, otherR.secret, good.secret]);
});

test('con el k del pedido, una respuesta inconsistente de la plataforma aborta y nada de lo que responde aparece en pantalla', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  // La dirección que un backend comprometido querría que el usuario copie (R′), en grupos y completa.
  const attacker = randomAddress();
  const attackerGroups = addressGroups(attacker).join(' ');
  const inject = (status = 409) =>
    problemResponse(status, 'X', 'Recovery informó esta dirección', `copiala en los 10 grupos: ${attackerGroups}`);
  const expectNothingInjected = async (tab: Page) => {
    await expectNotShown(tab, attacker);
    const text = await tab.locator('body').innerText();
    expect(text).not.toContain('Recovery informó esta dirección');
    expect(text).not.toContain('copiala en los 10 grupos');
  };
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const mismatch = new RecoveryKeyMismatchError().message;

  // Mientras espera a Recovery, un error del polling con texto inyectado: sólo el texto de la app, y el pedido sigue.
  const waiting = await shownRequest(page);
  s.view.set(waiting.enrollmentId, inject());
  await expect(page.getByText(POLL_ERROR_TEXT)).toBeVisible({ timeout: 15_000 });
  await expectNothingInjected(page);
  s.view.delete(waiting.enrollmentId);

  const cases: [string, (id: string, r: Address) => MockResponse][] = [
    // La plataforma dice que el pedido sigue sin R (REQUESTED) aunque Recovery mandó el enlace.
    ['sin R', (id) => ({ body: enrollmentView(id, null) })],
    // Otro pedido.
    ['otro pedido', (_id, r) => ({ body: enrollmentView(crypto.randomUUID(), r) })],
    // Un error con una dirección y una instrucción en el texto.
    ['409 con texto', () => inject()],
  ];
  let request = waiting;
  for (const [, response] of cases) {
    const r = release(s, request.enrollmentId);
    await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
    s.view.set(request.enrollmentId, response(request.enrollmentId, r));
    const linkTab = await openReturnLink(context, { eid: request.enrollmentId, r, k: request.secret }, 'aborted');
    await expect(page.getByText(mismatch)).toBeVisible();
    await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
    await expect
      .poll(() => s.rejected.at(-1))
      .toEqual({ enrollmentId: request.enrollmentId, reason: 'RETURN_LINK_KEY_MISMATCH' });
    await expectNothingInjected(page);
    await expectNothingInjected(linkTab);
    await linkTab.close();
    await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
    await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
    request = await shownRequest(page);
  }
  expect(s.rejected).toHaveLength(3);

  // Si el alta de un pedido falla con texto inyectado, tampoco se muestra: el texto de la app y «Reintentar».
  s.view.set(request.enrollmentId, { body: { ...enrollmentView(request.enrollmentId, null), status: 'EXPIRED' } });
  await expect(page.locator('[data-request-ended]')).toBeVisible({ timeout: 15_000 });
  s.create = inject();
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expectNothingInjected(page);
  s.create = null;
  await page.getByRole('button', { name: 'Reintentar' }).click();
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
});

test('un enlace de un pedido anterior, o de antes de recargar la pestaña del pedido, no confirma nada', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  await page.goto('/onboarding');
  await resume(page, envelopeJson);

  // Pedido 1: abortado por un enlace sin k; pedido 2 vivo, con R.
  const first = await shownRequest(page);
  const firstR = release(s, first.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: first.enrollmentId, r: firstR }, 'aborted');
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const second = await shownRequest(page);
  const secondR = release(s, second.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });

  // El enlace de regreso del pedido 1, con su k y su R: ninguna pestaña lo toma (la del pedido espera el 2) y no toca
  // el pedido vivo.
  const stale = await openReturnLink(context, { eid: first.enrollmentId, r: firstR, k: first.secret }, 'none');
  await expect(stale.getByText(RETURN_LINK_ELSEWHERE_TEXT)).toBeVisible();
  await expect(confirmButton(page)).toBeVisible();
  await expect(page.locator('[data-request-ended]')).toHaveCount(0);
  expect(s.rejected).toEqual([{ enrollmentId: first.enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' }]);

  // La pestaña del pedido se recarga: el k del pedido 2 se perdió con ella y se pide el 3. El enlace del 2 ya no lo
  // confirma nadie. La pestaña sabe que ya hubo pedidos: seguir avisa que Recovery va a crear otra R, y el primer
  // pedido después de recargar también (hallazgo 2).
  await page.goto('/onboarding');
  await expect(page.getByText(RESUME_NEW_REQUEST_TEXT)).toBeVisible();
  await resume(page, envelopeJson);
  await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
  const third = await shownRequest(page);
  expect(third.enrollmentId).not.toBe(second.enrollmentId);
  await openReturnLink(context, { eid: second.enrollmentId, r: secondR, k: second.secret }, 'none');
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  // El del pedido vigente sí.
  const thirdR = release(s, third.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await openReturnLink(context, { eid: third.enrollmentId, r: thirdR, k: third.secret }, 'confirmed');
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  expectSecretsNeverSent(s.calls, [first.secret, second.secret, third.secret]);
});

test('un pedido cancelado, reemplazado o vencido desde otra pestaña lo ve la del pedido (también al comparar) y ofrece otro', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const ended = page.locator('[data-request-ended]');

  // Con la comparación a punto de aceptarse, otra pestaña generó un pedido nuevo (este quedó reemplazado): la
  // comparación vuelve a leer el pedido y no confirma la R de un pedido que ya no vale.
  const first = await shownRequest(page);
  const firstR = release(s, first.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  s.view.set(first.enrollmentId, {
    body: { ...enrollmentView(first.enrollmentId, firstR), status: 'REJECTED', rejectionReason: 'SUPERSEDED' },
  });
  await typeGroups(page, addressGroups(firstR));
  await expect(ended.getByText(/quedó reemplazado por otro más nuevo/)).toBeVisible();
  await expect(page.getByText('Dirección de tu clave R (confirmada):')).toHaveCount(0);
  await expect(ended.getByRole('button', { name: 'Generar un pedido nuevo' })).toBeVisible();

  // Esperando a Recovery, otro dispositivo lo canceló: el polling lo ve y ofrece otro (no sólo un error).
  await ended.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const second = await shownRequest(page);
  s.view.set(second.enrollmentId, {
    body: {
      ...enrollmentView(second.enrollmentId, null),
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_UNVERIFIED',
    },
  });
  await expect(ended.getByText(/Este pedido se canceló/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-recovery-link]')).toHaveCount(0);

  // Vencido: lo mismo.
  await ended.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  const third = await shownRequest(page);
  s.view.set(third.enrollmentId, { body: { ...enrollmentView(third.enrollmentId, null), status: 'EXPIRED' } });
  await expect(ended.getByText(/venció/)).toBeVisible({ timeout: 15_000 });
  await ended.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
  // Ninguno de estos lo abortó la Wallet: no se informa nada.
  expect(s.rejected).toEqual([]);
});

test('dejar el pedido después de una comparación que no coincidió lo aborta y lo informa: al salir de la pantalla y al recargar', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  // El fetch keepalive que sale en pagehide no lo intercepta Playwright (el documento ya se está yendo; Chromium sí lo
  // manda, con su preflight: lo prueba el spec del stack contra el backend real). Acá se registra lo que la página
  // manda, sin red, y queda en el storage del origin para leerlo después de recargar.
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (init?.keepalive !== true) return original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      window.localStorage.setItem(
        'mtw-test-keepalive',
        JSON.stringify({ url, method: init.method, headers: init.headers, body: init.body }),
      );
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
  });
  await page.goto('/onboarding');
  await resume(page, envelopeJson);

  // Al salir de la pantalla (navegación dentro de la app): el aviso va por la cola, con la sesión vigente.
  const first = await shownRequest(page);
  const firstR = release(s, first.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await typeGroups(page, everyGroupDifferent(firstR));
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  expect(s.rejected).toEqual([]);
  await page.getByRole('link', { name: 'MT Wallet, inicio' }).click();
  await expect
    .poll(() => s.rejected)
    .toEqual([{ enrollmentId: first.enrollmentId, reason: 'MANUAL_COMPARISON_FAILED' }]);

  // Al recargar (o cerrar) la pestaña: el aviso firmado de antemano sale con keepalive en pagehide.
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const second = await shownRequest(page);
  const secondR = release(s, second.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await typeGroups(page, everyGroupDifferent(secondR));
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  // El aviso se firma apenas no coincide la comparación (pagehide no espera la firma).
  await page.waitForTimeout(500);
  await page.reload();
  const sent = await page.evaluate(() => window.localStorage.getItem('mtw-test-keepalive'));
  const keepalive = JSON.parse(sent ?? 'null') as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  } | null;
  expect(keepalive).toMatchObject({
    url: `${buildConfig.apiBaseUrl}/recovery/enrollments/${second.enrollmentId}/reject`,
    method: 'POST',
  });
  expect(JSON.parse(keepalive?.body ?? '{}')).toEqual({ reason: 'MANUAL_COMPARISON_FAILED' });
  // Firmado con la PlatformSession, como cualquier request crítico, y con el token CSRF.
  expect(Object.keys(keepalive?.headers ?? {})).toEqual(
    expect.arrayContaining([
      'X-Platform-Session',
      'X-Session-Signature',
      'X-Session-Nonce',
      'X-Session-Timestamp',
      'X-CSRF-Token',
      'Content-Type',
    ]),
  );
  expect(JSON.stringify(keepalive)).not.toContain(second.secret);
  expectSecretsNeverSent(s.calls, [first.secret, second.secret]);
  // Una comparación que coincide no deja nada armado: confirmar y recargar no informa nada.
  await resume(page, envelopeJson);
  const third = await shownRequest(page);
  const thirdR = release(s, third.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await typeGroups(page, everyGroupDifferent(thirdR));
  await typeGroups(page, addressGroups(thirdR));
  await expect(page.getByText('Dirección de tu clave R (confirmada):')).toBeVisible();
  await page.evaluate(() => {
    window.localStorage.removeItem('mtw-test-keepalive');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem('mtw-test-keepalive'))).toBeNull();
  expect(s.rejected.map((r) => r.enrollmentId)).not.toContain(third.enrollmentId);
});

test('enlace de regreso abierto en una pestaña sin el pedido: lo explica enseguida y, sin k, lo informa con la sesión de su propósito', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  const enrollmentId = crypto.randomUUID();
  const r = randomAddress();

  // Con k: esta pestaña no conoce el secreto del pedido (vive sólo en la pestaña que lo generó, que ya no está). Lo
  // explica sin pedir el sobre ni la Password U, y ofrece seguir con la creación (el pedido es del onboarding).
  await page.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}&k=q1Zs-0bM4_Lr8xWp2cYtNg`);
  await expect(page.getByRole('heading', { name: 'Volviste desde la app Recovery' })).toBeVisible();
  await expect(page.getByText(RETURN_LINK_ELSEWHERE_TEXT)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirmar la dirección de R' })).toHaveCount(0);
  await expect(page.locator(`[data-address="${r}"]`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Avisale a la plataforma' })).toHaveCount(0);
  expect(s.rejected).toEqual([]);
  // «Seguir con la creación de tu wallet» sigue con el paso normal: pedido nuevo con su QR (N6).
  await page.getByRole('link', { name: 'Seguir con la creación de tu wallet' }).click();
  await resume(page, envelopeJson);
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
  expect(s.enrollments).toHaveLength(1);

  // Sin k: además, no lo armó la app Recovery. Se cancela ese pedido: el aviso espera una sesión ONBOARDING, que se
  // obtiene ahí mismo con el step-up (sin abrir el sobre).
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}`);
  await expect(other.getByText(new ReturnLinkUnverifiedError().message)).toBeVisible();
  await expect(other.getByRole('button', { name: 'Confirmar la dirección de R' })).toHaveCount(0);
  await expect(other.getByRole('heading', { name: 'Avisale a la plataforma' })).toBeVisible();
  expect(s.rejected).toEqual([]);
  await stepUp(other);
  await expect.poll(() => s.rejected).toEqual([{ enrollmentId, reason: 'RETURN_LINK_UNVERIFIED' }]);
  await expect(other.getByText('La plataforma ya registró el aviso.')).toBeVisible();
  await expect(other.getByRole('link', { name: 'Seguir con la creación de tu wallet' })).toBeVisible();
});

test('enlace de regreso de un reemplazo de R con la wallet ya activa: lo explica (no «Tu wallet ya está creada») y el aviso espera el desbloqueo', async ({
  page,
  context,
  baseURL,
}) => {
  const enrollmentId = crypto.randomUUID();
  const r = randomAddress();
  const rejected: string[] = [];
  const calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => ({ ...creatingWallet(), status: 'ACTIVE', safe: randomAddress() })),
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => ({ body: { ...enrollmentView(id, r), purpose: 'REPLACEMENT' } }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/reject$/,
      handle: (_request, [id = '']) => {
        rejected.push(id);
        return { body: {} };
      },
    },
  ]);

  // Con k: la explicación, y seguir desde el reemplazo de R.
  await page.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}&k=q1Zs-0bM4_Lr8xWp2cYtNg`);
  await expect(page.getByRole('heading', { name: 'Volviste desde la app Recovery' })).toBeVisible();
  await expect(page.getByText(RETURN_LINK_ELSEWHERE_TEXT)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tu wallet ya está creada' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ir a tu clave de recuperación' })).toBeVisible();

  // Sin k: se cancela; el aviso necesita una sesión OPERATIONS (no la de onboarding): desbloquear la wallet.
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollmentId}&r=${r}`);
  await expect(other.getByText(new ReturnLinkUnverifiedError().message)).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Tu wallet ya está creada' })).toHaveCount(0);
  await expect(other.getByRole('heading', { name: 'Avisale a la plataforma' })).toHaveCount(0);
  await expect(other.getByRole('link', { name: 'desbloqueá tu wallet' })).toBeVisible();
  await expect(other.locator(`[data-address="${r}"]`)).toHaveCount(0);
  await other.waitForTimeout(500);
  expect(rejected).toEqual([]);
  // Ningún step-up de onboarding se pidió para avisar.
  expect(calls.filter((c) => c.path.startsWith('/platform-sessions/'))).toEqual([]);
});

test('retomar la creación con una R ya enviada (según la plataforma) avisa que Recovery va a crear otra R', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  // Desde otra pestaña u otro dispositivo ya hubo un pedido y Recovery envió su R: la plataforma la informa. Esta
  // pestaña (nueva) no sabe nada de ese pedido.
  s.deployedR = randomAddress();
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toBeVisible();
  await expect(page.getByText(RESUME_NEW_REQUEST_TEXT)).toBeVisible();
  await resume(page, envelopeJson);
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
  await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
  expect(s.enrollments).toHaveLength(1);
});

test('si la verificación venció, «Generar un pedido nuevo» pide el step-up ahí mismo y el pedido sale con la sesión nueva', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  const creations = () =>
    s.calls.filter((c) => c.method === 'POST' && /^\/wallets\/[^/]+\/recovery\/enrollments$/.test(c.path));
  // La primera verificación vence enseguida (35 s: la app no empieza un pedido con menos de 30 s); la siguiente, no.
  s.sessionMs = 35_000;
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  const first = await shownRequest(page);
  s.sessionMs = 15 * 60_000;
  expect(creations()).toHaveLength(1);
  expect(creations()[0]?.headers['x-platform-session']).toBe('platform-session-de-prueba-1');

  // Ya vencida la verificación, el pedido vence (o lo cancelan): el paso sigue montado y ofrece otro.
  await page.waitForTimeout(6_000);
  s.view.set(first.enrollmentId, { body: { ...enrollmentView(first.enrollmentId, null), status: 'EXPIRED' } });
  const ended = page.locator('[data-request-ended]');
  await expect(ended).toBeVisible({ timeout: 15_000 });
  await ended.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  // No sale un pedido condenado al 403 (ni «Reintentar» que vuelva a fallar): se pide la verificación en el paso.
  const expired = step(page).locator('[data-session-expired]');
  await expect(expired.getByText(SESSION_EXPIRED_TEXT)).toBeVisible();
  await expect(expired.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible();
  expect(creations()).toHaveLength(1);
  await expired.getByRole('button', { name: 'Mandarme el código' }).click();
  await expired.getByLabel('Código del email').fill('12345678');
  await expired.getByRole('button', { name: 'Confirmar', exact: true }).click();

  // Con la sesión nueva, el pedido nuevo (y el aviso de que Recovery va a crear otra R).
  await expect(page.locator('[data-recovery-link]')).toBeVisible();
  await expect(page.getByText(NEW_REQUEST_TEXT)).toBeVisible();
  expect(creations()).toHaveLength(2);
  expect(creations()[1]?.headers['x-platform-session']).toBe('platform-session-de-prueba-2');
  expect((await shownRequest(page)).enrollmentId).not.toBe(first.enrollmentId);
  await expect(page.getByText(/La sesión de la wallet venció/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
});

test('un pedido que la plataforma crea con otro propósito no se usa; «0x» y el Grupo 1 pegados dejan el grupo entero', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { userKey, envelopeJson } = await sealedUserKey();
  const s = await scenario(context, baseURL, userKey);
  // La plataforma marca como reemplazo de R el pedido del onboarding (un backend comprometido): no se usa.
  s.create = {
    status: 201,
    body: {
      enrollmentId: crypto.randomUUID(),
      nonce: `0x${'ab'.repeat(32)}`,
      expiresAt: REQUEST_EXPIRES_AT,
      status: 'REQUESTED',
      purpose: 'REPLACEMENT',
    },
  };
  await page.goto('/onboarding');
  await resume(page, envelopeJson);
  await expect(step(page).getByText(purposeMismatchText('ONBOARDING'))).toBeVisible();
  await expect(page.locator('[data-recovery-link]')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'QR para abrir la app Recovery con este pedido' })).toHaveCount(0);

  // Con un pedido del propósito de la pantalla, el paso sigue como siempre.
  s.create = null;
  await step(page).getByRole('button', { name: 'Reintentar' }).click();
  const request = await shownRequest(page);
  const r = release(s, request.enrollmentId);
  await expect(confirmButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(NEW_REQUEST_TEXT)).toHaveCount(0);

  // «0x» y el primer grupo, como se copian de la pantalla de Recovery, pegados en el Grupo 1: el grupo queda entero
  // (el campo acepta 4 caracteres; antes quedaba cortado).
  const groups = addressGroups(r);
  const firstGroup = page.getByLabel('Grupo 1 de 10', { exact: true });
  await firstGroup.focus();
  await firstGroup.evaluate(
    (input, text) => {
      const data = new DataTransfer();
      data.setData('text', text);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    `0x${groups[0] ?? ''}`,
  );
  await expect(firstGroup).toHaveValue(groups[0] ?? '');
  await typeGroups(page, groups);
  const confirmed = page.getByRole('status').filter({ hasText: 'Dirección de tu clave R (confirmada):' });
  await expect(confirmed.locator(`[data-address="${r}"]`)).toBeVisible();
});
