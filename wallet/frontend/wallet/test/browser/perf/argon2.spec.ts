// P17.T08 [F-KEY-03], ADR-013: rendimiento de Argon2id (64 MiB, t=3, p=4) en el worker real de la app, cargado por la
// política de Trusted Types, en el perfil móvil de referencia: emulación de dispositivo móvil y CPU 4× más lenta. El
// límite de CPU lo pone Docker (`--cpus 0.25`, verificado antes de medir por scripts/perf-browser.mjs): el throttling de
// CDP no alcanza a los workers (sólo frena el hilo principal) y WebKit no tiene throttling propio. Se registran las
// muestras y el p95 en test-results/perf/argon2-<navegador>.json y en la salida; el resultado y la decisión quedan en
// ADR-013 (presupuesto: p95 ≤ 3 s).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SAMPLES = Number(process.env.MTW_ARGON2_SAMPLES ?? 12);
const BUDGET_MS = 3_000;

async function measure(page: Page, run: number): Promise<number> {
  await page.getByRole('button', { name: 'Medir derivación' }).click();
  const result = page.locator(`p.result[data-run="${String(run)}"]`);
  await expect(result).toBeVisible({ timeout: 300_000 });
  return Number(await result.getAttribute('data-elapsed-ms'));
}

test('Argon2id en el perfil móvil de referencia (CPU 4×): p95 registrado', async ({ page, browserName }) => {
  const cpus = process.env.MTW_PERF_CPUS;
  expect(cpus, 'correr con scripts/perf-browser.mjs (CPU limitada y verificada por Docker)').toBe('0.25');
  await page.goto('/device-check');
  await expect(page.getByRole('heading', { name: 'Comprobar este dispositivo' })).toBeVisible();
  const samples: number[] = [];
  for (let i = 1; i <= SAMPLES; i++) samples.push(await measure(page, i));
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? NaN;
  const result = {
    browser: browserName,
    device: test.info().project.name,
    cpuLimit: `Docker --cpus ${cpus ?? ''} (factor verificado: ${process.env.MTW_PERF_CPU_FACTOR ?? '?'}×)`,
    params: { memoryKiB: 65536, iterations: 3, parallelism: 4 },
    samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? NaN,
    p95Ms: p95,
    budgetMs: BUDGET_MS,
    withinBudget: p95 <= BUDGET_MS,
    measuredAt: new Date().toISOString(),
  };
  const out = resolve(import.meta.dirname, `../../../test-results/perf/argon2-${browserName}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  // También en la salida de la corrida (CI no publica test-results): sin datos sensibles.
  console.log(`argon2id-perf ${JSON.stringify(result)}`);
  expect(samples).toHaveLength(SAMPLES);
  expect(Number.isFinite(p95)).toBe(true);
});
