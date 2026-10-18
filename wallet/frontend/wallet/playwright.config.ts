// Tests de navegador de la app Wallet (P16: headers y Trusted Types contra `vite preview` del build; desde P17 también
// contra el stack local). `pnpm test:browser [filtro]` compila antes de correr (scripts/test-browser.mjs).
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.MTW_PREVIEW_PORT ?? 4173);

export default defineConfig({
  testDir: 'test/browser',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${String(port)}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
