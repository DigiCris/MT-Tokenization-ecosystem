// §10 regla 2: la copia del signer de los vectores y las ABIs de contracts/ es idéntica a la fuente.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- script .mjs sin tipos
import { diffArtifacts } from '../../scripts/sync-contract-artifacts.mjs';

describe('artefactos de contratos', () => {
  it('vectores y ABIs iguales a contracts/', () => {
    expect((diffArtifacts as () => string[])()).toEqual([]);
  });
});
