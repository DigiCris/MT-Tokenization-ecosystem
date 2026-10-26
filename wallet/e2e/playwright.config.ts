// E2E de MT Wallet (P22) contra el stack local real que levanta scripts/test-e2e.mjs: la Wallet y Recovery compiladas
// contra ese stack, cada una en su vista previa (los orígenes con los que se compilaron y que acepta el backend). Sin
// reintentos (el criterio de P22 son 3 corridas seguidas en verde) y un worker: los specs comparten el stack, la cadena
// y la cuenta de prueba de Drive. Con MTW_E2E_RECORD=1 graba video y trace de todo (P22.MAN); si no, sólo de lo que
// falla.
import { defineConfig, devices, type Project } from '@playwright/test';

const WALLET_PORT = Number(process.env.MTW_E2E_WALLET_PORT ?? 4274);
const RECOVERY_PORT = Number(process.env.MTW_E2E_RECOVERY_PORT ?? 5274);
const record = process.env.MTW_E2E_RECORD === '1';

const DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' } as const;

function isBrowser(name: string): name is keyof typeof DEVICES {
  return Object.hasOwn(DEVICES, name);
}

/** MTW_BROWSERS: lista separada por comas (scripts/test-e2e.mjs usa la matriz completa por defecto). */
function browserProjects(): Project[] {
  const names = (process.env.MTW_BROWSERS ?? 'chromium')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.map((name) => {
    if (!isBrowser(name)) throw new Error(`MTW_BROWSERS: navegador desconocido ${name}`);
    return { name, use: { ...devices[DEVICES[name]] } };
  });
}

function preview(app: 'wallet' | 'recovery', port: number) {
  return {
    command: `pnpm exec vite preview --port ${String(port)} --strictPort`,
    cwd: `../frontend/${app}`,
    url: `http://localhost:${String(port)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  };
}

export default defineConfig({
  testDir: 'specs',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${String(WALLET_PORT)}`,
    trace: record ? 'on' : 'retain-on-failure',
    video: record ? 'on' : 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: browserProjects(),
  webServer: [preview('wallet', WALLET_PORT), preview('recovery', RECOVERY_PORT)],
});
