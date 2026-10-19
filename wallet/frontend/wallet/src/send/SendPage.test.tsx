// @vitest-environment jsdom
// P18.MAN (B6, B7): el monto se lee como lo escribió el usuario y debajo del campo se ve cómo se interpreta; "1.000"
// (como la app muestra los miles) no se toma como 1: se pregunta si se quiso decir 1000 y no se prepara nada. Los
// destinos se eligen por su label entre «», con la dirección completa.
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinnedChain } from '../config/chain.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { byLabel, render, settle, submit, typeInto, type Mounted } from '../ui/dom.test-helper.ts';
import { SendPage } from './SendPage.tsx';

const m = vi.hoisted(() => ({
  api: { whitelist: vi.fn(), prepareSend: vi.fn(), operation: vi.fn(), cancelOperation: vi.fn() },
  reader: { readContract: vi.fn(), getBlock: vi.fn() },
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

const DEST: Address = getAddress('0x6dfd2d7600000000000000000000000000003a23');

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.api.whitelist.mockResolvedValue({
    entries: [
      {
        id: 'e1',
        destination: DEST,
        label: 'Cuenta de Ana',
        status: 'ACTIVE',
        activatesAt: null,
        activatedAt: null,
        origin: 'PLATFORM',
        addedTxHash: null,
      },
    ],
  });
  m.reader.readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
    const usdc = address.toLowerCase() === pinnedChain.tokens.usdc.address.toLowerCase();
    if (functionName === 'symbol') return Promise.resolve(usdc ? 'USDC' : 'USDT');
    if (functionName === 'decimals') return Promise.resolve(6);
    if (functionName === 'balanceOf') return Promise.resolve(usdc ? 1_500_000_000n : 0n);
    if (functionName === 'destinationsOf') return Promise.resolve([DEST]);
    if (functionName === 'destinationInfo') return Promise.resolve([true, 1n, true]);
    return Promise.reject(new Error(`lectura inesperada: ${functionName}`));
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function openSend(): Promise<HTMLElement> {
  view = await render(
    <MemoryRouter initialEntries={['/send']}>
      <SendPage />
    </MemoryRouter>,
  );
  await settle(10);
  return view.container;
}

describe('envío', () => {
  it('el destino por su label entre «» y la dirección completa', async () => {
    const c = await openSend();
    expect(c.querySelector('#send-destination option')?.textContent).toBe(`«Cuenta de Ana» — ${groupAddress(DEST)}`);
  });

  it('debajo del monto, cómo se interpreta; "1.000" pregunta si se quiso decir 1000 y no prepara nada', async () => {
    const c = await openSend();
    const field = byLabel(c, 'Monto (USDC)');
    expect(c.textContent).toContain('Disponible: 1.500,00 USDC.');
    await typeInto(field, '1000');
    expect(c.querySelector('[data-amount-reading]')?.textContent).toBe(' Vas a enviar 1.000,00 USDC.');
    expect(c.querySelector('[data-amount-reading]')?.getAttribute('data-amount-reading')).toBe('1000000000');
    await typeInto(field, '1.000');
    expect(c.querySelector('[data-amount-reading="invalid"]')?.textContent).toBe(
      ' ¿Quisiste decir 1000? Escribí el monto sin separador de miles (y, si hace falta, una coma para los decimales).',
    );
    await submit(field.form!);
    await settle();
    expect(m.api.prepareSend).not.toHaveBeenCalled();
    expect(c.querySelector('.notice--error')?.textContent).toMatch(/^¿Quisiste decir 1000\?/);
  });
});
