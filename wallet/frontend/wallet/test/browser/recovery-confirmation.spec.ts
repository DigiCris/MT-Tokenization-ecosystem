// Confirmación de la dirección de R sin enlace de regreso ([F-LNK-02], hallazgo B2 de la revisión de P17.MAN) contra
// `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts): al retomar la creación con U ya registrada y
// activar Recovery, la Wallet no muestra la R que informa el backend antes de confirmarla (ni completa ni en grupos);
// una dirección distinta avisa que alguien pudo cambiarla y no deja seguir, un error de tipeo dice qué grupo revisar sin
// revelar lo esperado, el tercer intento fallido aborta el pedido (que después tampoco confirma un enlace de regreso) y
// la dirección correcta, en mayúsculas o minúsculas, recién ahí se muestra como confirmada y habilita seguir. Revisa
// también los avisos de la pantalla (B1, O6) y el paso actual del indicador (O13).
import { expect, test, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { serializeEnvelope } from '../../src/crypto/envelope.ts';
import { addressOf, generatePrivateKey } from '../../src/crypto/keys.ts';
import { ONBOARDING_KEY_VERSION, LOST_U_AND_R_WARNING, sealUserKey } from '../../src/onboarding/user-key.ts';
import { addressGroups, MANUAL_ABORT_TEXT, MANUAL_MISMATCH_TEXT } from '../../src/recovery-activation/activation.ts';
import { deriveArgon2id } from '../../src/workers/argon2-protocol.ts';
import {
  accountRoutes,
  buildConfig,
  creatingWallet,
  enrollmentView,
  mockApi,
  onboardingStepUpRoutes,
  WALLET_ID,
} from './helpers/mock-api.ts';

test.use({ timezoneId: 'America/Argentina/Buenos_Aires' });

/** Password U de prueba (ya normalizada): el sobre se arma acá, fuera del navegador. */
const PASSWORD_U = 'acorn violet marble tundra zebra';

const randomAddress = (): Address => addressOf(generatePrivateKey());

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

test('la R del backend no se muestra antes de confirmar; distinta avisa; 3 intentos abortan; la correcta confirma', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const key = generatePrivateKey();
  const userKey = addressOf(key);
  const sealed = await sealUserKey(
    { key, address: userKey },
    PASSWORD_U,
    { platformId: buildConfig.platformId, walletId: WALLET_ID, keyVersion: ONBOARDING_KEY_VERSION },
    (input) => deriveArgon2id(input),
  );
  // La R que "recibió" la plataforma en cada pedido (la que la Wallet compara); el primero espera a que Recovery la envíe.
  const reported = [randomAddress(), randomAddress()] as const;
  const enrollments: string[] = [];
  let submitted = false;
  const calls = await mockApi(context, new URL(baseURL ?? '').origin, [
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
        enrollments.push(enrollmentId);
        return {
          status: 201,
          body: {
            enrollmentId,
            nonce: `0x${'ab'.repeat(32)}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
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
        // El primer pedido espera a que Recovery envíe R; el segundo ya la tiene.
        const first = enrollments.indexOf(id) === 0;
        const recoveryKey = first ? (submitted ? reported[0] : null) : reported[1];
        return { body: enrollmentView(id, recoveryKey) };
      },
    },
  ]);

  // Pestaña recargada con U ya registrada: se retoma abriendo el sobre con la Password U.
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Seguir con la creación' })).toBeVisible();
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeEnvelope(sealed.envelope)),
  });
  await page.getByLabel('Password U').fill(PASSWORD_U);
  await page.getByRole('button', { name: 'Abrir el sobre' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmá que sos vos' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();

  // Activar Recovery: el QR recomendado, qué no viaja a servidores y qué pasa si se pierden U y R.
  const step = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Activar Recovery' }) });
  await expect(step).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Recovery');
  await expect(step.getByText(LOST_U_AND_R_WARNING)).toBeVisible();
  await expect(step.getByText(/^Te recomendamos crear tu clave R en otro dispositivo, como tu celular/)).toBeVisible();
  await expect(step.getByText(/Si mandás el enlace por chat o por email, sí pasa por esos servicios/)).toBeVisible();
  await expect(step.getByText('Esperando que Recovery informe la dirección de tu clave R…')).toBeVisible();

  // Recovery informa R: la Wallet pide copiarla de Recovery y no la muestra.
  submitted = true;
  const confirm = page.getByRole('button', { name: 'Confirmar la dirección de R' });
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await expect(
    step.getByText(
      'Si no, copiá la dirección que muestra la app Recovery, no la de esta pantalla. Sirve para comprobar que nadie la cambió en el camino; da igual mayúsculas o minúsculas.',
      { exact: false },
    ),
  ).toBeVisible();
  await expectNotShown(page, reported[0]);

  // 1) Recovery muestra otra dirección (la R cambió en el camino): aviso, no se puede seguir y la R sigue sin mostrarse.
  await typeGroups(page, addressGroups(randomAddress()));
  await expect(page.getByText(MANUAL_MISMATCH_TEXT)).toBeVisible();
  await expect(page.getByText(/volvé a confirmar \(te quedan 2 intentos\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);
  await expectNotShown(page, reported[0]);

  // 2) Un error de tipeo: dice qué grupo revisar, sin revelar lo esperado.
  const typo = addressGroups(reported[0]).map((g, i) => (i === 5 ? (g === '0000' ? '1111' : '0000') : g));
  await typeGroups(page, typo);
  await expect(
    page.getByText('Si te equivocaste al copiar, revisá el grupo 6 y volvé a confirmar (te queda 1 intento).'),
  ).toBeVisible();
  await expect(page.getByLabel('Grupo 6 de 10', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Grupo 5 de 10', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Continuar' })).toHaveCount(0);

  // 3) El tercer intento fallido aborta el pedido: sólo queda generar otro.
  await typeGroups(page, addressGroups(randomAddress()));
  await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
  await expect(page.getByLabel(/^Grupo \d+ de 10$/)).toHaveCount(0);
  await expectNotShown(page, reported[0]);
  // Abortado, tampoco lo confirma un enlace de regreso con la R que recibió la plataforma.
  const before = calls.length;
  const other = await context.newPage();
  await other.goto(`/onboarding/confirm-recovery#eid=${enrollments[0] ?? ''}&r=${reported[0]}`);
  await expect(other.getByText(/volvé a la pestaña de la Wallet/)).toBeVisible();
  await expect
    .poll(() =>
      calls.slice(before).some((c) => c.method === 'GET' && c.path === `/recovery/enrollments/${enrollments[0] ?? ''}`),
    )
    .toBe(true);
  await other.close();
  await page.waitForTimeout(500);
  await expect(page.getByText(MANUAL_ABORT_TEXT)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toHaveCount(0);

  // 4) Pedido nuevo: la dirección correcta (en minúsculas) confirma y recién ahí se muestra y se puede seguir.
  await page.getByRole('button', { name: 'Generar un pedido nuevo' }).click();
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  expect(enrollments).toHaveLength(2);
  await expectNotShown(page, reported[1]);
  await typeGroups(
    page,
    addressGroups(reported[1]).map((g) => g.toLowerCase()),
  );
  const confirmed = page.getByRole('status').filter({ hasText: 'Dirección de tu clave R (confirmada):' });
  await expect(confirmed.locator(`[data-address="${reported[1]}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparar la Safe' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]')).toHaveText('Safe');
});
