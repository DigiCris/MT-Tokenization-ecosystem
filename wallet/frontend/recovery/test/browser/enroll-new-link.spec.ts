// Contra `vite preview` con la API simulada: con Recovery ya en /enroll, un enlace de ida nuevo abierto en la misma
// pestaña sólo cambia el fragmento y el navegador no recarga la página. Recovery la recarga para tomar el pedido nuevo
// como cualquier enlace (lo del pedido anterior en memoria se descarta); un fragmento que no es un pedido no la recarga.
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { accountRoutes, enrollmentStepUpRoutes, enrollmentView, mockApi } from './helpers/mock-api.ts';

const FIRST = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SECOND = '6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c';
const NONCE = `0x${'ab'.repeat(32)}`;

function enrollLink(eid: string): string {
  return `/enroll#${new URLSearchParams({ eid, n: NONCE, k: randomBytes(16).toString('base64url') }).toString()}`;
}

test('un enlace nuevo en la misma pestaña recarga /enroll y toma el pedido nuevo', async ({
  page,
  context,
  baseURL,
}) => {
  const calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(),
    ...enrollmentStepUpRoutes('2030-01-01T15:10:00.000Z'),
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, null) }),
    },
  ]);
  const reads = (id: string) =>
    calls.filter((call) => call.method === 'GET' && call.path.endsWith(`/recovery/enrollments/${id}`)).length;

  await page.goto(enrollLink(FIRST));
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  await expect.poll(() => reads(FIRST)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  // Misma ruta, otro fragmento: para el navegador es una navegación dentro del documento.
  const reloaded = page.waitForEvent('load');
  await page.goto(enrollLink(SECOND));
  await reloaded;
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  await expect.poll(() => reads(SECOND)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  // Un fragmento que no es un pedido no recarga ni pide nada.
  const before = calls.length;
  const otherLoad = page.waitForEvent('load', { timeout: 1_500 });
  await page.evaluate(() => {
    window.location.hash = 'otra-cosa';
  });
  await expect(otherLoad).rejects.toThrow();
  expect(calls.length).toBe(before);
});
