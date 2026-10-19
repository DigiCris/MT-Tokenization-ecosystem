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
      // Lo que sólo existe en el navegador se prueba en el navegador real (test/browser, Playwright, contra el stack
      // real desde P19): las pantallas y componentes (*.tsx), la entrada, los módulos virtuales del build
      // (src/config/index.ts), los servicios de la app (src/app/**), IndexedDB, la descarga e impresión de archivos y la
      // creación del worker con Trusted Types; el worker corre en su propio hilo (su lógica es
      // src/workers/argon2-protocol.ts, probada acá). El chunk lazy de wallet externa (wagmi y conectores) se carga y se
      // prueba en Chromium (test/browser).
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/**/*.tsx',
        'src/app/**',
        'src/storage/envelope-cache.ts',
        'src/ui/download.ts',
        'src/ui/print.ts',
        'src/config/index.ts',
        'src/workers/*.worker.ts',
        'src/workers/argon2-client.ts',
        'src/workers/registry.ts',
        'src/external-wallet/**',
        // Generados por scripts/sync-abis.mjs desde contracts/out-abi (CI verifica que sean idénticos: abis:check).
        'src/chain/abis/**',
      ],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        'src/security/**': { lines: 90 },
        'src/config/**': { lines: 90 },
        'src/crypto/**': { lines: 90 },
        'src/api/**': { lines: 90 },
        'src/auth/**': { lines: 90 },
        'src/session/**': { lines: 90 },
        'src/drive/**': { lines: 90 },
        'src/storage/**': { lines: 90 },
        'src/qr/**': { lines: 90 },
        'src/chain/**': { lines: 90 },
        'src/signer/**': { lines: 90 },
        'src/operations/**': { lines: 90 },
        'src/enroll/**': { lines: 90 },
        'src/restore/**': { lines: 90 },
        'src/sovereign/**': { lines: 90 },
        'src/emergency/**': { lines: 90 },
        'src/migration/**': { lines: 90 },
        'src/ui/**': { lines: 90 },
      },
    },
  },
});
