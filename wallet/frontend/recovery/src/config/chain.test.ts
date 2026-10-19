// Config de cadena de Recovery (copia propia): Base mainnet con USDC y USDT (6 decimales) y la Safe v1.5.0 fijadas; un
// archivo de otra red o con direcciones o codehashes inválidos no se acepta.
import { describe, expect, it } from 'vitest';
import chainFile from './chain.base.json' with { type: 'json' };
import { explorerAddress, explorerTx, parseChain, pinnedChain } from './chain.ts';

const base = chainFile as unknown as Record<string, unknown> & { contracts: Record<string, Record<string, unknown>> };
const withContract = (name: string, patch: Record<string, unknown>) => ({
  ...base,
  contracts: { ...base.contracts, [name]: { ...base.contracts[name], ...patch } },
});

describe('cadena fijada', () => {
  it('tokens y Safe de Base con checksum; links del explorer', () => {
    expect(pinnedChain.chainId).toBe(8453);
    expect(pinnedChain.tokens.USDC).toEqual({
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
    });
    expect(pinnedChain.tokens.USDT).toMatchObject({ symbol: 'USDT', decimals: 6 });
    expect(pinnedChain.safe.proxyRuntimeCodehash).toBe(base.contracts.safeProxyFactory?.proxyRuntimeCodehash);
    expect(pinnedChain.safe.singletonL2Codehash).toBe(base.contracts.safeL2Singleton?.codehash);
    expect(explorerTx('0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerAddress('0xdef')).toBe('https://basescan.org/address/0xdef');
  });

  it('rechaza otra red, contratos faltantes o inválidos', () => {
    expect(() => parseChain(null)).toThrow('Base');
    expect(() => parseChain({ ...base, chainId: 1 })).toThrow('Base');
    expect(() => parseChain({ ...base, network: 'base-sepolia' })).toThrow('Base');
    expect(() => parseChain({ ...base, explorer: null })).toThrow('explorer');
    expect(() => parseChain({ ...base, contracts: undefined })).toThrow('contratos');
    expect(() => parseChain({ ...base, contracts: { ...base.contracts, usdc: undefined } })).toThrow('falta usdc');
    expect(() => parseChain(withContract('usdc', { address: '0x12' }))).toThrow('usdc');
    expect(() => parseChain(withContract('usdt', { decimals: 18 }))).toThrow('USDT');
    expect(() => parseChain(withContract('usdt', { symbol: 'USDC' }))).toThrow('USDT');
    expect(() => parseChain(withContract('safeProxyFactory', { proxyRuntimeCodehash: '0x1' }))).toThrow(
      'proxyRuntimeCodehash',
    );
    expect(() => parseChain(withContract('safeL2Singleton', { codehash: 'abc' }))).toThrow('codehash');
  });
});
