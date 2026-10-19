// `pnpm test:drive-live`: el cliente Drive de Recovery contra la API real de Google con la cuenta de prueba (P19,
// P22.T04). Fuera de `pnpm test` porque necesita credenciales y red, pero obligatorio en ci:local y en CI
// (ci/scripts/lib.sh lo corre en cada app que tiene el script).
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
