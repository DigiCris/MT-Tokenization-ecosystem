// Config de cadena embebida: Base mainnet con USDC y USDT (6 decimales) y la Safe v1.5 fijadas; un archivo de otra red o
// con direcciones inválidas no se acepta.
import { describe, expect, it } from 'vitest';
import chainFile from './chain.base.json';
import { parseChain, pinnedChain } from './chain.ts';

describe('cadena fijada', () => {
  it('tokens y Safe de Base con checksum', () => {
    expect(pinnedChain.chainId).toBe(8453);
    expect(pinnedChain.tokens.usdc).toMatchObject({ symbol: 'USDC', decimals: 6 });
    expect(pinnedChain.tokens.usdt).toMatchObject({ symbol: 'USDT', decimals: 6 });
    expect(pinnedChain.tokens.usdc.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(pinnedChain.safe.singletonL2).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(pinnedChain.explorer.tx).toBe('https://basescan.org/tx/');
  });

  it('rechaza otra red, contratos faltantes o inválidos', () => {
    const base = chainFile as unknown as Record<string, unknown> & {
      contracts: Record<string, Record<string, unknown>>;
    };
    expect(() => parseChain({ ...base, chainId: 1 })).toThrow('Base');
    expect(() => parseChain({ ...base, explorer: null })).toThrow('explorer');
    expect(() => parseChain({ ...base, contracts: undefined })).toThrow('contratos');
    expect(() =>
      parseChain({ ...base, contracts: { ...base.contracts, usdc: { ...base.contracts.usdc, address: '0x12' } } }),
    ).toThrow('usdc');
    expect(() =>
      parseChain({ ...base, contracts: { ...base.contracts, usdt: { ...base.contracts.usdt, decimals: '6' } } }),
    ).toThrow('usdt');
  });
});
