// Vitest del backend: unit + integración (PostgreSQL 18, Valkey 9 y Mailpit reales vía Testcontainers, Anvil sobre el
// fork de Base) + API (Fastify inject). El proyecto `security` agrupa los tests de P08.SEC/P09.SEC (`pnpm
// test:security`); `pnpm test` corre `backend` y `security` (cada archivo una sola vez) con cobertura. El proyecto
// `live` (`pnpm test:live`) son los tests contra servicios externos reales con cuota (Mailgun, Gmail API): CI los corre
// cuando cambian email/auth y en la corrida diaria (docs/CI.md).
import { defineConfig } from 'vitest/config';

/** Tests de seguridad: canarios de logs, inmutabilidad de audit_events, CORS, schemas de rutas, autenticación. */
const SECURITY_TESTS = [
  'test/observability/**/*.test.ts',
  'test/api/server-cors.test.ts',
  'test/api/openapi-coverage.test.ts',
  'test/audit/**/*.test.ts',
  'test/security/**/*.test.ts',
];

/** Contra servicios externos reales (`*.live.test.ts`). */
const LIVE_TESTS = ['test/**/*.live.test.ts'];

const shared = {
  // Los tests sobre el fork esperan transacciones reales y Anvil trae el estado del RPC remoto bajo demanda: en CI, con
  // el presupuesto de RPC compartido entre jobs, un test de varias transacciones puede pasar del minuto sin estar
  // colgado (cada espera tiene su propio límite y su condición real).
  testTimeout: 180_000,
  hookTimeout: 180_000,
  pool: 'forks' as const,
};

export default defineConfig({
  test: {
    // Una sola infraestructura por corrida para todos los proyectos (contenedores y sistema desplegado en el fork).
    globalSetup: ['test/setup/global-setup.ts'],
    // Los archivos de onboarding levantan cada uno un Anvil con el estado del sistema y dos shards del signer: más de
    // cuatro a la vez agotan la memoria de una máquina de desarrollo (y el ritmo del RPC remoto del fork).
    maxWorkers: 4,
    projects: [
      {
        test: {
          ...shared,
          name: 'backend',
          include: ['test/**/*.test.ts'],
          exclude: [...SECURITY_TESTS, ...LIVE_TESTS],
        },
      },
      { test: { ...shared, name: 'security', include: SECURITY_TESTS, exclude: LIVE_TESTS } },
      // Los archivos live comparten la cuenta de Mailgun (y su límite de ritmo): corren uno detrás del otro.
      { test: { ...shared, name: 'live', include: LIVE_TESTS, testTimeout: 420_000, fileParallelism: false } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Los entrypoints de proceso (main.ts y las CLIs) se prueban como procesos reales en
      // test/integration/{entrypoint,db-cli,executor-key-loss,migration}.test.ts y test/audit/audit-chain.test.ts: la
      // cobertura V8 de Vitest no incluye procesos hijos. Los ABIs son generados.
      exclude: ['src/chain/abis/**', 'src/main.ts', 'src/cli/**', 'src/operators/cli.ts'],
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
