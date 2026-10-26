// Avisos del reemplazo de U en el inicio, con la wallet bloqueada (el caso de quien perdió la Password U), contra `vite
// preview` con la API simulada (verificación de P17.MAN, B1 y N15; ESC-41): mientras el reemplazo está en borrador
// (RECOVERY_STARTED) o la app Recovery lo canceló (U_REPLACEMENT_REJECTED), la U′ que informa la plataforma no aparece
// en ningún lado de la página (puede ser la U″ de un backend comprometido); el aviso dice de dónde se copia la clave
// nueva. Con la propuesta ya en el timelock (ROTATION_PROPOSED), la dirección sí se muestra: sirve para compararla y
// cancelarla.
import { expect, test } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { addressOf, generatePrivateKey } from '../../src/crypto/keys.ts';
import { RECOVERY_STARTED_TEXT, U_REPLACEMENT_REJECTED_TEXT } from '../../src/notifications/texts.ts';
import { addressGroups } from '../../src/recovery-activation/activation.ts';
import { accountRoutes, creatingWallet, mockApi, WALLET_ID } from './helpers/mock-api.ts';

/** La dirección como la muestran las apps: «0x» y los 10 grupos de 4. */
const groupAddress = (address: Address) => `0x ${addressGroups(address).join(' ')}`;

const notice = (id: string, type: string, payload: Record<string, unknown>) => ({
  id,
  walletId: WALLET_ID,
  type,
  payload,
  readAt: null,
  createdAt: '2026-10-25T10:00:00.000Z',
});

test('el reemplazo de U en borrador o rechazado no muestra la U′ de la plataforma; en el timelock, sí', async ({
  page,
  context,
  baseURL,
}) => {
  const draftKey: Address = addressOf(generatePrivateKey());
  const rejectedKey: Address = addressOf(generatePrivateKey());
  const proposedKey: Address = getAddress(addressOf(generatePrivateKey()));
  const safe = addressOf(generatePrivateKey());
  await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => ({ ...creatingWallet(), status: 'ACTIVE', safe })),
    {
      method: 'GET',
      path: /^\/notifications$/,
      handle: () => ({
        body: {
          items: [
            notice('n1', 'RECOVERY_STARTED', { rotationId: 'r1', newKey: draftKey, safe }),
            notice('n2', 'U_REPLACEMENT_REJECTED', {
              rotationId: 'r0',
              reason: 'MANUAL_COMPARISON_FAILED',
              newKey: rejectedKey,
              safe,
            }),
            notice('n3', 'ROTATION_PROPOSED', {
              role: 'U',
              newKey: proposedKey,
              executableAt: '2026-10-27T10:00:00.000Z',
            }),
          ],
          unread: 3,
          nextCursor: null,
        },
      }),
    },
  ]);
  await page.goto('/');
  const started = page.locator('[data-notification="RECOVERY_STARTED"]');
  await expect(started).toContainText(RECOVERY_STARTED_TEXT);
  // De dónde se copia la clave nueva, y nada que cancelar todavía.
  expect(RECOVERY_STARTED_TEXT).toContain(
    'copiá la dirección de la clave U nueva sólo de la pantalla final de «Perdí mi Password U», nunca de un aviso, un email o un chat',
  );
  await expect(started.getByRole('link', { name: 'Ver rotaciones' })).toBeVisible();
  await expect(started.locator('[data-address]')).toHaveCount(0);
  const rejected = page.locator('[data-notification="U_REPLACEMENT_REJECTED"]');
  await expect(rejected).toContainText(U_REPLACEMENT_REJECTED_TEXT);
  await expect(rejected.locator('[data-address]')).toHaveCount(0);
  // Ni en el texto ni en atributos: ninguna forma de la dirección del borrador o del rechazado está en la página.
  const html = (await page.content()).toLowerCase();
  for (const key of [draftKey, rejectedKey]) {
    expect(html).not.toContain(key.slice(2).toLowerCase());
    expect(html).not.toContain(groupAddress(key).toLowerCase());
  }
  // En el timelock: la dirección completa, para compararla y cancelar si no la propuso el usuario.
  const proposed = page.locator('[data-notification="ROTATION_PROPOSED"]');
  await expect(proposed.locator(`[data-address="${proposedKey}"]`)).toHaveText(groupAddress(proposedKey));
  await expect(proposed).toContainText('cancelala antes de esa fecha');
});
