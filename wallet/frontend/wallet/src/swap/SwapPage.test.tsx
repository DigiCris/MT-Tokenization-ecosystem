// @vitest-environment jsdom
// P18.MAN: la cotización del swap vale sólo para el formulario con el que se pidió. Cualquier cambio (monto, sentido o
// slippage) la descarta antes de poder preparar, y una cotización que llega después de un cambio no se muestra. El
// formulario dice el token y el saldo disponible, y los porcentajes y montos van en es-AR con su token.
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwapQuote } from '../api/wallet-api.ts';
import { formatAmount } from '../assets/amount.ts';
import { pinnedChain } from '../config/chain.ts';
import { byLabel, byText, click, render, settle, submit, typeInto, type Mounted } from '../ui/dom.test-helper.ts';
import { minOutFor } from './swap.ts';
import { SwapPage } from './SwapPage.tsx';

const m = vi.hoisted(() => ({
  api: { swapQuote: vi.fn(), prepareSwap: vi.fn(), operation: vi.fn(), cancelOperation: vi.fn() },
  reader: { readContract: vi.fn(), simulateContract: vi.fn(), getBlock: vi.fn() },
}));

vi.mock('../app/services.ts', () => ({ api: m.api, chainReader: m.reader }));
vi.mock('../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: {
    contracts: {
      whitelist: {
        name: 'DestinationWhitelist',
        address: '0x00000000000000000000000000000000000000d1',
        codehash: '0x',
      },
      swapExecutor: { name: 'SwapExecutorV3', address: '0x00000000000000000000000000000000000000d2', codehash: '0x' },
      timelock: { name: 'RotationTimelock', address: '0x00000000000000000000000000000000000000d3', codehash: '0x' },
      guard: { name: 'SecurityGuard', address: '0x00000000000000000000000000000000000000d4', codehash: '0x' },
    },
  },
}));
vi.mock('../session/context.tsx', () => ({
  useSensitiveScreen: () => undefined,
  useSession: () => ({ status: 'account', user: { email: 'ana@test.invalid', totpEnabled: false } }),
}));
vi.mock('../safe/SafeGate.tsx', () => ({
  SafeGate: ({ children }: { children: (ctx: unknown) => ReactNode }) =>
    children({
      wallet: { id: 'w1', safe: '0x00000000000000000000000000000000000000A1', status: 'ACTIVE' },
      unlocked: { platform: { sessionId: 's1' } },
      reader: m.reader,
      state: {},
    }),
}));

const OWN = 19_990_000n;
const quote = (amountIn: string, slippageBps: number): SwapQuote => ({
  tokenIn: 'USDC',
  tokenOut: 'USDT',
  amountIn,
  expectedOut: '19991000',
  minOut: '19931000',
  slippageBps,
  priceImpactBps: 0,
  deadline: '1800000600',
  blockNumber: '1',
  quotedAt: '2026-10-19T10:00:00.000Z',
  pool: pinnedChain.uniswap.pool.address,
  fee: 100,
});

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.reader.getBlock.mockResolvedValue({ timestamp: 1_800_000_000n });
  m.reader.simulateContract.mockResolvedValue({ result: [OWN, 0n, 0, 0n] });
  // Saldos: 50 USDC y nada de USDT, con el símbolo y los decimales fijados.
  m.reader.readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
    const usdc = address.toLowerCase() === pinnedChain.tokens.usdc.address.toLowerCase();
    if (functionName === 'symbol') return Promise.resolve(usdc ? 'USDC' : 'USDT');
    if (functionName === 'decimals') return Promise.resolve(6);
    if (functionName === 'balanceOf') return Promise.resolve(usdc ? 50_000_000n : 0n);
    return Promise.reject(new Error(`lectura inesperada: ${functionName}`));
  });
  m.api.swapQuote.mockImplementation((_wallet: string, input: { amountIn: string; slippageBps: number }) =>
    Promise.resolve(quote(input.amountIn, input.slippageBps)),
  );
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function openSwap(): Promise<HTMLElement> {
  view = await render(
    <MemoryRouter initialEntries={['/swap']}>
      <SwapPage />
    </MemoryRouter>,
  );
  await settle();
  return view.container;
}

async function quoteFor(c: HTMLElement, amount: string): Promise<void> {
  const field = byLabel(c, /^Monto a cambiar/);
  await typeInto(field, amount);
  await submit(field.form!);
  await settle();
}

const hasQuote = (c: HTMLElement) => c.querySelector('[data-quote]') !== null;
const prepareButton = (c: HTMLElement) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent === 'Preparar el swap') ?? null;

describe('swap', () => {
  it('el monto dice el token y el disponible; slippage, cotización y mínimo en es-AR con su token', async () => {
    const c = await openSwap();
    expect(byLabel(c, 'Monto a cambiar (USDC)')).toBeTruthy();
    expect(c.textContent).toContain('Disponible: 50,00 USDC');
    for (const option of ['0,1 %', '0,3 %', '0,5 %']) expect(byText(c, 'label', option)).toBeTruthy();
    expect(c.textContent).not.toMatch(/0\.\d %/);
    await quoteFor(c, '20');
    expect(m.api.swapQuote).toHaveBeenCalledWith('w1', { tokenIn: 'USDC', amountIn: '20000000', slippageBps: 30 });
    const quoted = c.querySelector('[data-quote]');
    expect(quoted?.textContent).toContain('Cambiás20,00 USDC');
    expect(quoted?.querySelector('[data-own-out]')?.textContent).toBe(`${formatAmount(OWN, 6)} USDT`);
    expect(quoted?.textContent).toContain('Mínimo a recibir con 0,3 %');
    expect(quoted?.querySelector('[data-min-out]')?.textContent).toBe(`${formatAmount(minOutFor(OWN, 30), 6)} USDT`);
    expect(prepareButton(c)).not.toBeNull();
  });

  it('cambiar el monto, el slippage o el sentido descarta la cotización: no se puede preparar la vieja', async () => {
    const c = await openSwap();
    await quoteFor(c, '20');
    expect(hasQuote(c)).toBe(true);
    await typeInto(byLabel(c, /^Monto a cambiar/), '21');
    expect(hasQuote(c)).toBe(false);
    expect(prepareButton(c)).toBeNull();

    await quoteFor(c, '21');
    expect(hasQuote(c)).toBe(true);
    await click(byText(c, 'label', '0,5 %').querySelector('input')!);
    expect(hasQuote(c)).toBe(false);

    await quoteFor(c, '21');
    expect(m.api.swapQuote).toHaveBeenLastCalledWith('w1', { tokenIn: 'USDC', amountIn: '21000000', slippageBps: 50 });
    await click(byText(c, 'label', 'USDT por USDC').querySelector('input')!);
    expect(hasQuote(c)).toBe(false);
    expect(byLabel(c, 'Monto a cambiar (USDT)')).toBeTruthy();
    expect(c.textContent).toContain('Disponible: 0,00 USDT');
  });

  it('una cotización que llega después de un cambio del formulario no se muestra', async () => {
    let answer: (value: SwapQuote) => void = () => undefined;
    m.api.swapQuote.mockImplementationOnce(
      () =>
        new Promise<SwapQuote>((resolve) => {
          answer = resolve;
        }),
    );
    const c = await openSwap();
    const field = byLabel(c, /^Monto a cambiar/);
    await typeInto(field, '20');
    await submit(field.form!);
    await typeInto(field, '22');
    answer(quote('20000000', 30));
    await settle();
    expect(hasQuote(c)).toBe(false);
    expect(c.textContent).toContain('Cambiaste el formulario mientras se cotizaba: volvé a cotizar.');
  });

  it('sin saldo suficiente no cotiza', async () => {
    const c = await openSwap();
    await quoteFor(c, '60');
    expect(m.api.swapQuote).not.toHaveBeenCalled();
    expect(c.textContent).toContain('No tenés saldo suficiente de USDC.');
  });
});
