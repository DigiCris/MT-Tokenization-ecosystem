// @vitest-environment jsdom
// P18.MAN: la cotización del swap vale sólo para el formulario con el que se pidió. Cualquier cambio (monto, sentido o
// slippage) la descarta antes de poder preparar, y una cotización que llega después de un cambio no se muestra. El
// formulario dice el token, el saldo disponible y cómo se interpreta el monto escrito ("1.000" no se toma como 1), y
// los porcentajes y montos van en es-AR con su token. Un swap preparado cuyo plazo vence no se firma: se cancela lo
// preparado y se vuelve a cotizar el mismo monto. Hecho el swap, la pantalla lo cuenta en pasado con lo recibido de
// verdad (leído del recibo de la transacción).
import { act, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationStatus, PreparedOperation, SwapQuote } from '../api/wallet-api.ts';
import { formatAmount } from '../assets/amount.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type * as SignModule from '../operations/sign.ts';
import { byLabel, byText, click, render, settle, submit, typeInto, type Mounted } from '../ui/dom.test-helper.ts';
import { approveCall, minOutFor, swapCall } from './swap.ts';
import { SwapPage } from './SwapPage.tsx';

const m = vi.hoisted(() => ({
  api: { swapQuote: vi.fn(), prepareSwap: vi.fn(), operation: vi.fn(), cancelOperation: vi.fn() },
  reader: {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    getBlock: vi.fn(),
    getTransactionReceipt: vi.fn(),
  },
  signAndSubmit: vi.fn(),
  waitForOperation: vi.fn(),
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
vi.mock('../operations/sign.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SignModule>()),
  signAndSubmit: m.signAndSubmit,
  waitForOperation: m.waitForOperation,
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

const SAFE: Address = '0x00000000000000000000000000000000000000A1';
const EXECUTOR: Address = '0x00000000000000000000000000000000000000d2';
const CHAIN_NOW = 1_800_000_000n;
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
  m.reader.getBlock.mockResolvedValue({ timestamp: CHAIN_NOW });
  m.reader.simulateContract.mockResolvedValue({ result: [OWN, 0n, 0, 0n] });
  // Saldos: 50 USDC y nada de USDT, con el símbolo y los decimales fijados.
  m.reader.readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
    const usdc = address.toLowerCase() === pinnedChain.tokens.usdc.address.toLowerCase();
    if (functionName === 'symbol') return Promise.resolve(usdc ? 'USDC' : 'USDT');
    if (functionName === 'decimals') return Promise.resolve(6);
    if (functionName === 'balanceOf') return Promise.resolve(usdc ? 50_000_000n : 0n);
    if (functionName === 'nonce') return Promise.resolve(5n);
    if (functionName === 'allowance') return Promise.resolve(0n);
    return Promise.reject(new Error(`lectura inesperada: ${functionName}`));
  });
  m.api.swapQuote.mockImplementation((_wallet: string, input: { amountIn: string; slippageBps: number }) =>
    Promise.resolve(quote(input.amountIn, input.slippageBps)),
  );
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.useRealTimers();
});

/** El par que prepara el backend para 20 USDC: approve exacto (nonce 5) y swap (nonce 6) con el plazo dado. */
function preparedPair(deadline: bigint) {
  const usdc = pinnedChain.tokens.usdc.address;
  const json = (tx: SafeTx, type: PreparedOperation['operationType']): PreparedOperation => ({
    operationId: `op-${type}`,
    groupId: 'g1',
    walletId: 'w1',
    safe: SAFE,
    chainId: 8453,
    operationType: type,
    safeTx: {
      to: tx.to,
      value: '0',
      data: tx.data,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce.toString(),
    },
    safeTxHash: safeTxHash(8453, SAFE, tx),
    typedData: {},
    decoded: {},
    requiresTwoFactor: false,
    expiresAt: '2026-10-19T10:15:00.000Z',
  });
  const minAmountOut = minOutFor(OWN, 30);
  return {
    quote: quote('20000000', 30),
    operations: [
      json(approveCall(usdc, EXECUTOR, 20_000_000n, 5n), 'SWAP_APPROVE'),
      json(swapCall(EXECUTOR, { tokenIn: usdc, amountIn: 20_000_000n, minAmountOut, deadline }, 6n), 'SWAP'),
    ],
  };
}

const buttonTexts = (c: HTMLElement) => [...c.querySelectorAll('button')].map((b) => b.textContent);

async function prepareSwap(c: HTMLElement): Promise<void> {
  await quoteFor(c, '20');
  await click(byText(c, 'button', 'Preparar el swap'));
  await settle(10);
}

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

  it('debajo del monto, cómo se interpreta; "1.000" no se toma como 1: pregunta si se quiso decir 1000', async () => {
    const c = await openSwap();
    const field = byLabel(c, /^Monto a cambiar/);
    await typeInto(field, '20');
    expect(c.querySelector('[data-amount-reading]')?.textContent).toBe(' Vas a cambiar 20,00 USDC.');
    await typeInto(field, '1.000');
    expect(c.querySelector('[data-amount-reading="invalid"]')?.textContent).toContain('¿Quisiste decir 1000?');
    await submit(field.form!);
    await settle();
    expect(m.api.swapQuote).not.toHaveBeenCalled();
    expect(c.querySelector('.notice--error')?.textContent).toMatch(/^¿Quisiste decir 1000\?/);
  });

  it('la cotización propia: QuoterV2 simula contra el pool y, si difieren, manda la propia', async () => {
    const c = await openSwap();
    await quoteFor(c, '20');
    const hint = c.querySelector('[data-quote] .field__hint')?.textContent ?? '';
    expect(hint).toContain('con el contrato QuoterV2 de Uniswap, que simula este cambio contra el pool USDC/USDT');
    expect(hint).toContain('Si las dos cotizaciones no coinciden, manda la propia');
    expect(hint).toContain('la app no te deja firmarlo');
    expect(hint).not.toContain('preguntándole directamente al pool');
  });

  it('plazo vencido: no se firma; "Volver a cotizar" cancela lo preparado y cotiza de nuevo el mismo monto', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const device0 = Date.UTC(2026, 9, 19, 10, 0, 0);
    vi.setSystemTime(device0);
    // La cadena avanza con el reloj (bloques cada 2 s en el stack): su hora es la del bloque más reciente.
    m.reader.getBlock.mockImplementation(() =>
      Promise.resolve({ timestamp: CHAIN_NOW + BigInt(Math.floor((Date.now() - device0) / 1000)) }),
    );
    m.api.prepareSwap.mockResolvedValue(preparedPair(CHAIN_NOW + 600n));
    m.api.operation.mockResolvedValue({ status: 'CREATED' });
    m.api.cancelOperation.mockResolvedValue({});
    const c = await openSwap();
    await prepareSwap(c);
    expect(c.querySelector('#review-title')?.textContent).toBe('Revisá el swap');
    expect(buttonTexts(c)).toContain('Firmar las 2 operaciones con tu clave U');
    // Pasan 9 min 30 s: queda menos de un minuto y ya no da tiempo a firmarlo.
    await act(async () => {
      vi.setSystemTime(device0 + 570_000);
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(buttonTexts(c).some((b) => b.startsWith('Firmar'))).toBe(false);
    await click(byText(c, 'button', 'Volver a cotizar'));
    await settle(10);
    expect(m.api.cancelOperation).toHaveBeenCalledWith({ sessionId: 's1' }, 'op-SWAP_APPROVE');
    expect(m.api.cancelOperation).toHaveBeenCalledWith({ sessionId: 's1' }, 'op-SWAP');
    expect(m.api.swapQuote).toHaveBeenCalledTimes(2);
    expect(m.api.swapQuote).toHaveBeenLastCalledWith('w1', { tokenIn: 'USDC', amountIn: '20000000', slippageBps: 30 });
    expect(c.querySelector('[data-quote]')).not.toBeNull();
    expect(byLabel(c, /^Monto a cambiar/).value).toBe('20');
  });

  it('hecho: en pasado, con lo recibido leído del recibo de la transacción y el permiso en 0', async () => {
    m.api.prepareSwap.mockResolvedValue(preparedPair(CHAIN_NOW + 600n));
    const tx = `0x${'cd'.repeat(32)}` as const;
    m.signAndSubmit.mockResolvedValue({ status: 'USER_SIGNED' });
    m.waitForOperation.mockImplementation(
      (_api: unknown, id: string, options: { onUpdate?: (s: OperationStatus) => void }) => {
        const mined = {
          id,
          status: 'MINED',
          txHash: tx,
          failureReason: null,
          history: [],
        } as unknown as OperationStatus;
        options.onUpdate?.(mined);
        return Promise.resolve(mined);
      },
    );
    m.reader.getTransactionReceipt.mockResolvedValue({
      logs: [
        {
          address: pinnedChain.tokens.usdt.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: 'Transfer',
            args: { from: pinnedChain.uniswap.pool.address, to: SAFE },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [19_993_000n]),
        },
      ],
    });
    const c = await openSwap();
    await prepareSwap(c);
    expect(c.querySelector('[data-swap-summary]')?.textContent).toContain('Recibirías según la cotización propia');
    await click(byText(c, 'button', 'Firmar las 2 operaciones con tu clave U'));
    await settle(10);
    expect(c.querySelector('#review-title')?.textContent).toBe('Swap realizado');
    const summary = c.querySelector('[data-review]')?.textContent ?? '';
    expect(summary).toContain('Se ejecutaron las 2 operaciones, en orden');
    expect(summary).not.toContain('Son 2 operaciones que se firman juntas');
    expect(summary).not.toContain('Recibirías');
    expect(c.querySelector('[data-received-out]')?.textContent).toBe('19,993 USDT');
    expect(m.reader.getTransactionReceipt).toHaveBeenCalledWith({ hash: tx });
    expect([...c.querySelectorAll('.review__what')][1]?.textContent).toMatch(/^Cambiaste 20,00 USDC por USDT/);
    expect(c.querySelector('[data-allowance]')?.getAttribute('data-allowance')).toBe('0');
  });

  it('sin saldo suficiente no cotiza', async () => {
    const c = await openSwap();
    await quoteFor(c, '60');
    expect(m.api.swapQuote).not.toHaveBeenCalled();
    expect(c.textContent).toContain('No tenés saldo suficiente de USDC.');
  });
});
