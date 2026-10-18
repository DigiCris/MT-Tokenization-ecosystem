// P16.T05 [F-SEC-01]/[F-SEC-03]/[F-SEC-04]: `vite preview` del build sirve cada respuesta (documento, fallback de SPA,
// assets con hash, manifest) con los headers exactos de build/headers.json para el entorno, la cámara sólo en las rutas
// que escanean QR, y 403 a los pedidos de scripts de service worker.
import { expect, test } from '@playwright/test';
import { loadBuildConfig } from '../../../build/config.ts';
import { headersFor, securityHeaders } from '../../../build/headers.ts';

const config = loadBuildConfig();
const expected = securityHeaders(config);

function expectHeaders(actual: Record<string, string>, path: string) {
  for (const [name, value] of Object.entries(headersFor(expected, path))) {
    expect(actual[name.toLowerCase()], `${name} en ${path}`).toBe(value);
  }
}

for (const path of ['/', '/device-check', '/no/existe', '/.well-known/release-manifest.json', '/licenses/fonts.txt']) {
  test(`headers de seguridad en ${path}`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expectHeaders(response.headers(), path);
  });
}

test('los assets con hash (JS, CSS, fuentes y el worker) llevan los mismos headers', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? '');
  const manifest = (await (await request.get('/.well-known/release-manifest.json')).json()) as {
    files: { path: string }[];
  };
  const worker = manifest.files.find((f) => /^assets\/argon2\.worker-/.test(f.path));
  const font = manifest.files.find((f) => f.path.endsWith('.woff2'));
  expect(worker).toBeDefined();
  expect(font).toBeDefined();
  for (const asset of [...assets, `/${worker?.path ?? ''}`, `/${font?.path ?? ''}`]) {
    const response = await request.get(asset);
    expect(response.status(), asset).toBe(200);
    expectHeaders(response.headers(), asset);
  }
});

test('CSP de [F-SEC-01]: sin inline ni eval, Trusted Types exigidos y los hosts del entorno en connect-src', async ({
  request,
}) => {
  const csp = (await request.get('/')).headers()['content-security-policy'] ?? '';
  const directives = new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
  expect(directives.get('default-src')).toEqual(["'none'"]);
  expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(directives.get('style-src')).toEqual(["'self'"]);
  expect(directives.get('require-trusted-types-for')).toEqual(["'script'"]);
  expect(directives.get('trusted-types')).toEqual(['mtw-default']);
  expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
  expect(directives.get('connect-src')).toEqual(
    expect.arrayContaining(["'self'", config.apiOrigin, config.rpcOrigin, 'https://www.googleapis.com']),
  );
  expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
});

test('cámara sólo en las rutas que escanean QR', async ({ request }) => {
  const policy = async (path: string) => (await request.get(path)).headers()['permissions-policy'] ?? '';
  expect(await policy('/')).toContain('camera=()');
  expect(await policy('/device-check')).toContain('camera=()');
  expect(await policy('/restore')).toContain('camera=(self)');
  expect(await policy('/sovereign/import')).toContain('camera=(self)');
  expect(await policy('/restore')).toContain('microphone=()');
});

test('403 a los pedidos de scripts de service worker', async ({ request }) => {
  const response = await request.get('/assets/sw.js', { headers: { 'Service-Worker': 'script' } });
  expect(response.status()).toBe(403);
  const index = await request.get('/', { headers: { 'Service-Worker': 'script' } });
  expect(index.status()).toBe(403);
});
