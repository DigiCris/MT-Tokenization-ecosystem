// `pnpm test:drive-live`: tests contra servicios reales (Drive con la cuenta de prueba, P17.TST/P22.T04). Fuera de
// `pnpm test` porque necesitan credenciales y red, pero obligatorios en ci:local y en CI (ci/scripts/lib.sh).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 0,
  },
});
