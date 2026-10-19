// Vitest del integrity monitor: chequeos contra releases servidos por HTTP real (test/helpers/site.ts), ciclo con pausa
// pegajosa y persistente, reanudación con doble aprobación, API interna y el chequeo off-host como proceso real.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts se prueba como proceso real (check-once.test.ts): la cobertura V8 no incluye procesos hijos.
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: 'coverage',
      thresholds: { lines: 90 },
    },
  },
});
