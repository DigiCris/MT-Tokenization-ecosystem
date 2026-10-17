// La spec interna (openapi.json) está al día con los schemas Zod y documenta todas las rutas del servidor mTLS.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../scripts/openapi.ts';
import { SIGNER_ROOT } from './helpers/paths.ts';

describe('openapi.json interna', () => {
  it('coincide con la generada desde los schemas', () => {
    expect(readFileSync(resolve(SIGNER_ROOT, 'openapi.json'), 'utf8')).toBe(
      `${JSON.stringify(buildSpec(), null, 2)}\n`,
    );
  });

  it('documenta cada ruta registrada en el servidor', () => {
    const source = readFileSync(resolve(SIGNER_ROOT, 'src/api/server.ts'), 'utf8');
    const routes = [...source.matchAll(/app\.(get|post)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    const paths = buildSpec().paths as Record<string, Record<string, unknown>>;
    const documented = Object.entries(paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m} ${path}`))
      .sort();
    expect(routes).toEqual(documented);
  });
});
