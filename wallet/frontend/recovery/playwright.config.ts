// Tests de navegador de la app Recovery sin backend (P16: headers y Trusted Types contra `vite preview` del build). Los
// specs contra el stack local real (test/browser/stack) van con playwright.stack.config.ts; `pnpm test:browser
// [filtro]` compila antes de correr y elige la config (scripts/test-browser.mjs).
import { defineConfig } from '@playwright/test';
import { browserProjects } from './test/browser/projects.ts';

const port = Number(process.env.MTW_PREVIEW_PORT ?? 4174);

export default defineConfig({
  testDir: 'test/browser',
  testIgnore: ['stack/**'],
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${String(port)}`, trace: 'retain-on-failure' },
  projects: browserProjects(),
  webServer: {
    command: `pnpm exec vite preview --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
