// P16.T04 [F-SEC-02]/[F-SEC-04]: en Chromium contra `vite preview` del build. La app arranca con la CSP y Trusted Types
// activos sin violaciones (sólo las de sus pruebas de arranque, que no se reportan); el worker de Argon2id carga con
// Trusted Types forzado; un sink de prueba queda bloqueado y se reporta al backend sin datos sensibles; sin service
// workers; y ningún request sale del origin salvo el reporte al API host.
import { expect, test, type Page, type Request } from '@playwright/test';
import { loadBuildConfig } from '../../../build/config.ts';

const config = loadBuildConfig();
const REPORT = `${config.apiBaseUrl}/security/csp-report`;
/** Violaciones de las pruebas de arranque de src/security/csp-check.ts (no se reportan). */
const PROBES = new Set(['trusted-types|trusted-types-policy', 'require-trusted-types-for|trusted-types-sink']);

interface Recorded {
  directive: string;
  blocked: string;
  sample: string;
}

/** Registra las violaciones del documento desde antes de que corra la app (script de inicialización de Playwright). */
async function recordViolations(page: Page) {
  await page.addInitScript(() => {
    const recorded: { directive: string; blocked: string; sample: string }[] = [];
    Object.defineProperty(window, '__violations', { value: recorded });
    document.addEventListener('securitypolicyviolation', (e) => {
      recorded.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample });
    });
  });
}

async function violations(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __violations: Recorded[] }).__violations);
}

/** Intercepta el endpoint de reportes del API host (fuera del alcance de P16: el backend lo prueba con Fastify real). */
async function captureReports(page: Page) {
  const reports: Record<string, unknown>[] = [];
  await page.route(REPORT, async (route) => {
    const cors = {
      'access-control-allow-origin': new URL(page.url()).origin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    reports.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 204, headers: cors });
  });
  return reports;
}

const pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  await recordViolations(page);
  page.on('pageerror', (error) => pageErrors.push(error));
});

test.afterEach(() => {
  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('arranca con CSP y Trusted Types activos: sólo las violaciones de las pruebas de arranque, ningún reporte', async ({
  page,
}) => {
  const reports = await captureReports(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu wallet en Base, con tu clave en tu dispositivo');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const seen = await violations(page);
  expect(seen.map((v) => `${v.directive}|${v.blocked}`).sort()).toEqual([...PROBES].sort());
  await page.waitForTimeout(500);
  expect(reports).toEqual([]);
});

test('el worker de Argon2id carga con Trusted Types forzado y deriva con los parámetros reales', async ({ page }) => {
  const reports = await captureReports(page);
  await page.goto('/device-check');
  await page.getByRole('button', { name: 'Medir derivación' }).click();
  await expect(page.getByRole('status')).toHaveText(/^\d+\.\d{2} s — (dentro|por encima) del presupuesto de 3 s$/, {
    timeout: 120_000,
  });
  const extra = (await violations(page)).filter((v) => !PROBES.has(`${v.directive}|${v.blocked}`));
  expect(extra).toEqual([]);
  expect(reports).toEqual([]);
});

test('un sink de prueba queda bloqueado y se reporta sin el valor asignado', async ({ page }) => {
  const reports = await captureReports(page);
  await page.goto('/');
  const outcome = await page.evaluate(() => {
    const div = document.createElement('div');
    try {
      // eslint-disable-next-line no-restricted-syntax -- sink de prueba: Trusted Types lo tiene que bloquear
      div.innerHTML = '<img src=x>valor-secreto-123'; // nosemgrep: mtw-no-inner-html (sink de prueba bloqueado)
      return 'asignado';
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(outcome).toBe('TypeError');
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({
    type: 'CSP_VIOLATION',
    releaseId: config.releaseId,
    documentPath: '/',
    directive: 'require-trusted-types-for',
    disposition: 'enforce',
    blocked: 'trusted-types-sink',
    sample: 'Element innerHTML',
  });
  expect(JSON.stringify(reports)).not.toContain('valor-secreto-123');
});

test('un worker o un script con URL arbitraria quedan bloqueados', async ({ page }) => {
  await captureReports(page);
  await page.goto('/');
  const results = await page.evaluate(() => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'permitido';
      } catch (error) {
        return (error as Error).name;
      }
    };
    return {
      worker: attempt(() => new Worker('/assets/x.js')),
      script: attempt(() => {
        document.createElement('script').src = 'https://evil.example/x.js';
      }),
      // eslint-disable-next-line no-implied-eval, @typescript-eslint/no-implied-eval -- prueba: tiene que quedar bloqueado
      evaluate: attempt(() => setTimeout('1', 0)),
    };
  });
  expect(results).toEqual({ worker: 'TypeError', script: 'TypeError', evaluate: 'TypeError' });
});

test('sin service workers registrados', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test('ningún request a terceros al cargar (sólo el propio origin y la API de esta app)', async ({ page, baseURL }) => {
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  await page.goto('/');
  await page.goto('/device-check');
  await page.waitForLoadState('networkidle');
  const origin = new URL(baseURL ?? '').origin;
  const api = new URL(loadBuildConfig().apiBaseUrl);
  const foreign = requests
    .map((r) => new URL(r.url()))
    .filter((url) => url.origin !== origin && !(url.origin === api.origin && url.pathname.startsWith(api.pathname)));
  expect(foreign.map((url) => url.href)).toEqual([]);
  expect(requests.length).toBeGreaterThan(3);
});
