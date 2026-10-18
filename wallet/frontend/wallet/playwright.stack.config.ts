// Tests de navegador contra el stack local real (P17: cuenta, onboarding de U, desbloqueo, Password U, restauración y
// canarios): backend, worker, gas tank, signer, PostgreSQL, Valkey, Mailpit y Anvil sobre el fork, levantados por
// scripts/stack/stack.mjs desde scripts/test-browser.mjs, que compila la app con las URLs y los contratos de ese stack.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.MTW_STACK_PREVIEW_PORT ?? 4174);

export default defineConfig({
  testDir: 'test/browser/stack',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${String(port)}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
