// Tests de navegador de Recovery contra el stack local real (P19: enrollment, recuperación de U, rotaciones, modo
// soberano con el backend apagado, restauración, emergencia, migración y conectores de wallet externa): backend, worker,
// gas tank, signer, PostgreSQL, Valkey, Mailpit y Anvil sobre el fork, levantados por scripts/stack/stack.mjs desde
// scripts/test-browser.mjs, que compila la app con las URLs, los contratos y la clave de atestación de ese stack.
import { defineConfig } from '@playwright/test';
import { browserProjects } from './test/browser/projects.ts';

const port = Number(process.env.MTW_STACK_PREVIEW_PORT ?? 5175);

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
  projects: browserProjects(),
  webServer: {
    command: `pnpm exec vite preview --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
