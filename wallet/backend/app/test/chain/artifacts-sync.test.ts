// §10 regla 2: las copias locales de vectores y ABIs son idénticas a las de contracts/ (CI corre este test).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(import.meta.dirname, '../..');

describe('artefactos de contratos', () => {
  it('vectores y ABIs iguales a la fuente (sync-contract-artifacts --check)', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-contract-artifacts.mjs', '--check'], {
      cwd: APP,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('los SHA-256 fijados en test/vectors/SHA256SUMS coinciden con las copias', () => {
    const sums = readFileSync(resolve(APP, 'test/vectors/SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums.length).toBeGreaterThanOrEqual(12);
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/);
      const actual = createHash('sha256')
        .update(readFileSync(resolve(APP, 'test/vectors', file ?? '')))
        .digest('hex');
      expect(actual, file).toBe(hash);
    }
  });
});
