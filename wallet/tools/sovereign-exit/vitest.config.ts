// Vitest de la herramienta: la cripto y la SafeTx contra los vectores de contracts/ (unit) y el build de release (dos
// builds reales idénticos, un único HTML con su CSP por hashes y la firma del release). La interfaz se prueba de punta a
// punta en el navegador contra el fork (test/e2e, Playwright).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/release/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // La interfaz (DOM) y el acceso al RPC se prueban en el navegador contra el fork (test/e2e).
      exclude: ['src/main.ts', 'src/dom.ts', 'src/safe/chain.ts'],
      reporter: ['text-summary', 'text', 'json-summary'],
      thresholds: { lines: 90 },
    },
  },
});
