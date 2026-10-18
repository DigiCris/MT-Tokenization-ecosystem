// src/config/chain.base.json es la copia propia de la app de config/chains/base-mainnet.json (direcciones fijadas de
// Base): tiene que ser idéntica byte a byte (§10, regla 2: cada app con su copia verificada).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, WALLET_ROOT } from '../../build/config.ts';

describe('copia de la config de Base', () => {
  it('es idéntica a config/chains/base-mainnet.json', () => {
    const copy = readFileSync(resolve(APP_ROOT, 'src/config/chain.base.json'));
    const source = readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'));
    expect(copy.equals(source)).toBe(true);
  });
});
