// P18.T03/T04/T06: montos con bigint y los decimales fijados (sin punto flotante) y activos leídos on-chain contra la
// config fijada: símbolo o decimales distintos bloquean; un saldo del backend distinto al de la cadena se marca.
// P18.MAN (B6): la app muestra los miles con punto, así que "1.000" no se toma como 1: se pregunta si se quiso decir
// 1000, y debajo del campo se muestra cómo se interpreta lo escrito.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Balances } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import { AmountError, formatAmount, parseAmount, parseDecimalAmount, readAmount, withoutThousands } from './amount.ts';
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

  it.each(['', 'abc', '1.000,50', '-1', '1,2345678', '1e3', '12.', '1.000.5'])('rechaza %s', (text) => {
    expect(() => parseAmount(text, 6)).toThrow(AmountError);
  });

  it.each([
    ['1500', 1_500_000_000n],
    ['500.125', 500_125_000n],
    ['1.000', 1_000_000n],
    ['0.000001', 1n],
  ])('monto de máquina del backend %s → %s unidades (punto decimal, sin miles)', (text, units) => {
    expect(parseDecimalAmount(text, 6)).toBe(units);
  });

  it.each(['', '1,5', '1.000,50', '-1', '1.2345678', '1e3', '12.'])('el parser de máquina rechaza %s', (text) => {
    expect(() => parseDecimalAmount(text, 6)).toThrow(AmountError);
  });

  it.each([
    ['1.000', '1000'],
    ['12.500', '12500'],
    ['1.000.000', '1000000'],
    ['1.000,50', '1000,50'],
    ['1,000.50', '1000,50'],
    ['1,000,000', '1000000'],
  ])('"%s" con separador de miles es ambiguo: pregunta si se quiso decir %s', (text, meant) => {
    expect(withoutThousands(text)).toBe(meant);
    expect(() => parseAmount(text, 6)).toThrow(
      `¿Quisiste decir ${meant}? Escribí el monto sin separador de miles (y, si hace falta, una coma para los decimales).`,
    );
  });

  it.each([
    ['1.5', 1_500_000n],
    ['1.50', 1_500_000n],
    ['1.5000', 1_500_000n],
    ['0.001', 1_000n],
    ['0,125', 125_000n],
    ['1000.000', 1_000_000_000n],
    // Coma decimal (es-AR): "1,000" es uno con tres decimales, no mil; debajo del campo se ve "1,00".
    ['1,000', 1_000_000n],
  ])('sin ambigüedad: "%s" → %s unidades', (text, units) => {
    expect(withoutThousands(text)).toBeNull();
    expect(parseAmount(text, 6)).toBe(units);
  });

  it('cómo se interpreta lo escrito, para mostrarlo debajo del campo', () => {
    expect(readAmount('', 6)).toBeNull();
    expect(readAmount('  ', 6)).toBeNull();
    expect(readAmount('1000', 6)).toEqual({ ok: true, units: 1_000_000_000n, text: '1.000,00' });
    expect(readAmount('1,5', 6)).toEqual({ ok: true, units: 1_500_000n, text: '1,50' });
    expect(readAmount('1.000', 6)).toEqual({
      ok: false,
      message:
        '¿Quisiste decir 1000? Escribí el monto sin separador de miles (y, si hace falta, una coma para los decimales).',
    });
    expect(readAmount('abc', 6)).toMatchObject({ ok: false });
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
