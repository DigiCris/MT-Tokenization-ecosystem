// La copia propia de Recovery de la config de Base (src/config/chain.base.json) es byte a byte la de
// config/chains/base-mainnet.json (§10 regla 2: copia por app, verificada; nada se importa de fuera del proyecto).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, WALLET_ROOT } from '../../build/config.ts';

describe('config de cadena', () => {
  it('src/config/chain.base.json es idéntico a config/chains/base-mainnet.json', () => {
    const copy = readFileSync(resolve(APP_ROOT, 'src/config/chain.base.json'));
    const source = readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'));
    expect(copy.equals(source)).toBe(true);
  });
});
