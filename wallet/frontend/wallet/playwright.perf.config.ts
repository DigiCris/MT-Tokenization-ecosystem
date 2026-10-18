// Medición de Argon2id en el perfil móvil de referencia (P17.T08, ADR-013): la corre scripts/perf-browser.mjs dentro de
// la imagen fijada de Playwright con la CPU limitada por Docker (`--cpus 0.25`: el worker de Argon2id, de un hilo, corre
// 4× más lento) contra la vista previa del build servida en el host. Emulación de dispositivo móvil en Chromium y WebKit.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser/perf',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  workers: 1,
  timeout: 30 * 60_000,
  reporter: [['list']],
  outputDir: 'test-results/perf-artifacts',
  use: { baseURL: process.env.MTW_PERF_BASE_URL ?? 'http://127.0.0.1:4175', trace: 'off' },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] } },
  ],
});
