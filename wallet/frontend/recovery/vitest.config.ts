// Vitest de la app Recovery: unit (lógica de seguridad, contratos fijados, protocolo de Argon2id), tests del build de
// release (dos builds reales: sin inline, SRI, manifest firmado y reproducible) y grafo del bundle (wagmi sólo lazy). Los tests de navegador van con
// Playwright (`pnpm test:browser`).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/*.test.ts', 'test/unit/**/*.test.ts', 'test/build/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 600_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Lo que sólo existe en el navegador se prueba en el navegador real (test/browser, Playwright): las pantallas, la
      // entrada, los módulos virtuales del build (src/config/index.ts) y la creación del worker con Trusted Types; el
      // worker corre en su propio hilo (su lógica es src/workers/argon2-protocol.ts, probada acá).
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/app/**',
        'src/config/index.ts',
        'src/workers/*.worker.ts',
        'src/workers/argon2-client.ts',
        'src/workers/registry.ts',
        // El chunk lazy de wallet externa (wagmi y conectores) se carga y se prueba en Chromium (test/browser).
        'src/external-wallet/**',
      ],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { 'src/security/**': { lines: 90 }, 'src/config/**': { lines: 90 } },
    },
  },
});
