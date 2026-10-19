// E2E de la herramienta de salida soberana (P19.T09): el HTML del build abierto desde el disco (file://) en Chromium,
// contra el fork del stack local con la plataforma apagada (scripts/test-e2e.mjs levanta el stack, detiene backend y
// worker y lo desarma al terminar). No hay servidor web: la herramienta no lo necesita.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', acceptDownloads: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
