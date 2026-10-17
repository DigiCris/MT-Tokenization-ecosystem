// Vitest del signer: unit (cripto, keystore, policy, reglas estáticas) + integración (PostgreSQL 18 real vía
// Testcontainers y Anvil sobre el fork de Base con el sistema desplegado por los scripts reales) + API mTLS. El proyecto
// `security` agrupa los tests de P11.SEC (`pnpm test:security`); `pnpm test` corre `signer` y `security` con cobertura.
import { defineConfig } from 'vitest/config';

const SECURITY_TESTS = ['test/security/**/*.test.ts'];

const shared = {
  testTimeout: 120_000,
  hookTimeout: 900_000,
  pool: 'forks' as const,
};

export default defineConfig({
  test: {
    // Una sola vez por corrida (no por proyecto): un PostgreSQL y un deploy del sistema compartidos por signer y
    // security (cada archivo usa su propia DB clonada y su propio Anvil con el estado cargado).
    globalSetup: ['test/setup/global-setup.ts'],
    // Cada archivo de integración levanta sus propios Anvil sobre el fork, que piden estado al RPC remoto (Alchemy,
    // con límite de ritmo): pocos archivos a la vez evitan ráfagas de 429.
    maxWorkers: 4,
    projects: [
      { test: { ...shared, name: 'signer', include: ['test/**/*.test.ts'], exclude: SECURITY_TESTS } },
      { test: { ...shared, name: 'security', include: SECURITY_TESTS } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts y las CLIs se prueban como procesos reales (test/cli, test/lifecycle): la cobertura V8 no incluye
      // procesos hijos. Los ABIs son generados.
      exclude: ['src/chain/abis/**', 'src/main.ts', 'src/cli/**'],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: 'coverage',
      thresholds: {
        // §10: ≥ 90 % de líneas en chain/ y policy/.
        'src/chain/**': { lines: 90 },
        'src/policy/**': { lines: 90 },
      },
    },
  },
});
