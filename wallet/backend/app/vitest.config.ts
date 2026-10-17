// Vitest del backend: unit + integración (PostgreSQL 18 y Valkey 9 reales vía Testcontainers, Anvil sobre el fork de
// Base) + API (Fastify inject). El proyecto `security` agrupa los tests de P08.SEC (`pnpm test:security`); `pnpm test`
// corre los dos proyectos (cada archivo una sola vez) con cobertura.
import { defineConfig } from 'vitest/config';

/** Tests de seguridad (P08.SEC): canarios de logs, inmutabilidad de audit_events, CORS, schemas de rutas. */
const SECURITY_TESTS = [
  'test/observability/**/*.test.ts',
  'test/api/server-cors.test.ts',
  'test/api/openapi-coverage.test.ts',
  'test/audit/**/*.test.ts',
  'test/security/**/*.test.ts',
];

const shared = {
  globalSetup: ['test/setup/global-setup.ts'],
  testTimeout: 60_000,
  hookTimeout: 180_000,
  pool: 'forks' as const,
};

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: 'backend', include: ['test/**/*.test.ts'], exclude: SECURITY_TESTS } },
      { test: { ...shared, name: 'security', include: SECURITY_TESTS } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Los entrypoints de proceso (main.ts y las CLIs) se prueban como procesos reales en
      // test/integration/{entrypoint,db-cli}.test.ts y test/audit/audit-chain.test.ts: la cobertura V8 de Vitest no
      // incluye procesos hijos. Los ABIs son generados.
      exclude: ['src/chain/abis/**', 'src/main.ts', 'src/cli/**'],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        // §10: ≥ 90 % de líneas en chain/, domain/ y policy/.
        'src/chain/**': { lines: 90 },
        'src/domain/**': { lines: 90 },
        'src/policy/**': { lines: 90 },
      },
    },
  },
});
