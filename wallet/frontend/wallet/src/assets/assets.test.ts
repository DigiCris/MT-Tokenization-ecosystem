// P18.T03/T04/T06: montos con bigint y los decimales fijados (sin punto flotante) y activos leídos on-chain contra la
// config fijada: símbolo o decimales distintos bloquean; un saldo del backend distinto al de la cadena se marca.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Balances } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import { AmountError, formatAmount, parseAmount } from './amount.ts';
import { readAssets, TokenConfigError, type TokenReader } from './assets.ts';

const SAFE: Address = '0x2Ffa853A9213C92A16295C55FA6A5b27A6498688';

describe('montos', () => {
  it.each([
    ['12', 12_000_000n],
    ['12,5', 12_500_000n],
    ['12.50', 12_500_000n],
    ['0,000001', 1n],
    [' 1000 ', 1_000_000_000n],
  ])('%s → %s unidades', (text, units) => {
    expect(parseAmount(text, 6)).toBe(units);
  });

  it.each(['', 'abc', '1.000,50', '-1', '1,2345678', '1e3', '12.'])('rechaza %s', (text) => {
    expect(() => parseAmount(text, 6)).toThrow(AmountError);
  });

  it('formato es-AR sin perder precisión', () => {
    expect(formatAmount(1_234_567_890_000n, 6)).toBe('1.234.567,89');
    expect(formatAmount(1n, 6)).toBe('0,000001');
    expect(formatAmount(12_000_000n, 6)).toBe('12,00');
    expect(formatAmount(0n, 6)).toBe('0,00');
    expect(formatAmount(-1_500_000n, 6)).toBe('-1,50');
  });
});

function reader(overrides: Partial<Record<string, unknown>> = {}): TokenReader {
  const values: Record<string, unknown> = {
    [`${pinnedChain.tokens.usdc.address}:symbol`]: 'USDC',
    [`${pinnedChain.tokens.usdc.address}:decimals`]: 6,
    [`${pinnedChain.tokens.usdc.address}:balanceOf`]: 25_000_000n,
    [`${pinnedChain.tokens.usdt.address}:symbol`]: 'USDT',
    [`${pinnedChain.tokens.usdt.address}:decimals`]: 6,
    [`${pinnedChain.tokens.usdt.address}:balanceOf`]: 0n,
    ...overrides,
  };
  return {
    readContract: ({ address, functionName }: { address: Address; functionName: string }) =>
      Promise.resolve(values[`${address}:${functionName}`]),
  } as unknown as TokenReader;
}

const backend = (usdc: string, usdt: string): Balances => ({
  walletId: 'w',
  safe: SAFE,
  chainId: 8453,
  blockNumber: '1',
  tokens: [
    {
      symbol: 'USDC',
      address: pinnedChain.tokens.usdc.address,
      decimals: 6,
      balance: usdc,
      allowanceToSwapExecutor: '0',
    },
    {
      symbol: 'USDT',
      address: pinnedChain.tokens.usdt.address,
      decimals: 6,
      balance: usdt,
      allowanceToSwapExecutor: '0',
    },
  ],
});

describe('activos on-chain', () => {
  it('saldos de la cadena cruzados con el backend', async () => {
    const assets = await readAssets(reader(), pinnedChain, SAFE, backend('25000000', '1'));
    expect(assets.map((a) => [a.symbol, a.balance, a.backendMismatch])).toEqual([
      ['USDC', 25_000_000n, false],
      ['USDT', 0n, true],
    ]);
    expect((await readAssets(reader(), pinnedChain, SAFE, null))[0]?.backendBalance).toBeNull();
  });

  it('símbolo o decimales distintos de la config: error bloqueante', async () => {
    await expect(
      readAssets(reader({ [`${pinnedChain.tokens.usdt.address}:decimals`]: 18 }), pinnedChain, SAFE, null),
    ).rejects.toBeInstanceOf(TokenConfigError);
    await expect(
      readAssets(reader({ [`${pinnedChain.tokens.usdc.address}:symbol`]: 'USDC.e' }), pinnedChain, SAFE, null),
    ).rejects.toBeInstanceOf(TokenConfigError);
  });
});
