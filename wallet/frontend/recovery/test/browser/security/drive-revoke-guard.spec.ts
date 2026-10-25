// Ningún test puede revocar en Google el token de la cuenta de prueba (test/browser/stack/helpers/drive.ts): con la
// protección del contexto, un `fetch` o un `sendBeacon` de la página a /revoke se responden en la propia página, sin
// salir a la red, y quedan registrados. Usa tokens inventados: nunca uno real.
import { expect, test } from '@playwright/test';
import { REVOKE_URL } from '../../../src/drive/token.ts';
import { blockGoogleRevocation } from '../stack/helpers/drive.ts';

test('con la protección del contexto, la revocación de Google nunca sale de la página', async ({ page, context }) => {
  const consent = await blockGoogleRevocation(context);
  const network: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname === new URL(REVOKE_URL).hostname) network.push(request.url());
  });
  await page.goto('/');
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'token-inventado-fetch' }).toString(),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    });
    const beacon = navigator.sendBeacon(url, new URLSearchParams({ token: 'token-inventado-beacon' }));
    return { status: response.status, beacon };
  }, REVOKE_URL);
  expect(result).toEqual({ status: 200, beacon: true });
  await expect.poll(() => consent.revoked).toEqual(['token-inventado-fetch', 'token-inventado-beacon']);
  expect(network).toEqual([]);
  // Otra llamada en el mismo contexto devuelve la misma protección (no se registra dos veces).
  expect(await blockGoogleRevocation(context)).toBe(consent);
});
