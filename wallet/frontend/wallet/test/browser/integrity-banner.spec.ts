// P20.T03 [F-SEC]: con la co-firma pausada por integridad (GET /platform/status → PAUSED) la app muestra el aviso en
// todas las pantallas; con la cooperación activa, no. El backend se simula interceptando el pedido (spec sin backend).
import { expect, test, type Page } from '@playwright/test';
import { loadBuildConfig } from '../../build/config.ts';

const config = loadBuildConfig();
const STATUS = `${config.apiBaseUrl}/platform/status`;

async function platformStatus(page: Page, cooperation: 'ACTIVE' | 'PAUSED') {
  await page.route(STATUS, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': new URL(page.url()).origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': (await request.headerValue('access-control-request-headers')) ?? '',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({
        integrity: 'MONITORED',
        cooperation,
        apps: [
          { app: 'WALLET', status: cooperation === 'PAUSED' ? 'MISMATCH' : 'OK', releaseId: 'w', observedAt: null },
          { app: 'RECOVERY', status: 'OK', releaseId: 'r', observedAt: null },
        ],
      }),
    });
  });
}

test('cooperación pausada: aviso visible con qué hacer', async ({ page, baseURL }) => {
  await page.goto('/device-check');
  await platformStatus(page, 'PAUSED');
  await page.goto(`${baseURL ?? ''}/login`);
  const banner = page.getByRole('alert').filter({ hasText: 'La plataforma pausó la co-firma de operaciones' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('herramienta de salida soberana');
});

test('cooperación activa: sin aviso', async ({ page, baseURL }) => {
  await page.goto('/device-check');
  await platformStatus(page, 'ACTIVE');
  await page.goto(`${baseURL ?? ''}/login`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('La plataforma pausó la co-firma de operaciones')).toHaveCount(0);
});
