// Tests de navegador de la app Wallet sin backend contra `vite preview` del build: headers y Trusted Types (P16). Los
// specs contra el stack real están en playwright.stack.config.ts y la medición de Argon2id con la CPU limitada en
// playwright.perf.config.ts. `pnpm test:browser [filtro]` compila antes (scripts/test-browser.mjs).
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.MTW_PREVIEW_PORT ?? 4173);

export default defineConfig({
  testDir: 'test/browser',
  testIgnore: ['stack/**', 'perf/**'],
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
