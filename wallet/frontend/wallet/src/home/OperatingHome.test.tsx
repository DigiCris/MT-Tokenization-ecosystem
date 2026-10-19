// @vitest-environment jsdom
// P18.MAN (ADR-006, ESC-16, P15.T07): el inicio alerta por cada destino de la whitelist que todavía se está activando
// (leído de la cadena, con el nombre entre «» y la dirección completa y cuánto falta según la hora de la cadena) con
// acceso directo a la baja, también si no es la dirección que se esperaba, y muestra los avisos in-app del backend sin
// leer, que se pueden marcar como leídos: cada uno con su tono, la hora una sola vez y la IP sin notación de red. La
// clave U se muestra completa y agrupada.
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import type { OperatingWallet } from '../safe/SafeGate.tsx';
import { groupAddress } from '../ui/AddressText.tsx';
import { byText, click, render, settle, type Mounted } from '../ui/dom.test-helper.ts';
import { readableIpPrefix } from '../notifications/NotificationsPanel.tsx';
import { OperatingHome } from './OperatingHome.tsx';

const m = vi.hoisted(() => ({
  api: {
    balances: vi.fn(),
    listRotations: vi.fn(),
    whitelist: vi.fn(),
    operations: vi.fn(),
    transfers: vi.fn(),
    notifications: vi.fn(),
    markNotificationRead: vi.fn(),
  },
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
vi.mock('../ui/QrCanvas.tsx', () => ({ QrCanvas: () => null }));

const SAFE: Address = '0x00000000000000000000000000000000000000A1';
const KEY: Address = getAddress('0x00000000000000000000000000000000000000b2');
const DEST: Address = getAddress('0xf0a10000000000000000000000000000000076a3');
const CHAIN_NOW = 1_800_000_000n;

const ctx = {
  wallet: { id: 'w1', safe: SAFE, status: 'ACTIVE', chainId: 8453, createdAt: '', activatedAt: null },
  unlocked: { envelope: { keyAddress: KEY } },
  reader: m.reader,
  state: {},
} as unknown as OperatingWallet;

const requested: AppNotification = {
  id: 'n1',
  walletId: 'w1',
  type: 'WHITELIST_REQUESTED',
  payload: { requestId: 'r1', destination: DEST, label: 'Proveedor', expiresAt: '2026-10-19T10:15:00.000Z' },
  readAt: null,
  createdAt: '2026-10-19T10:00:00.000Z',
};

function Probe() {
  const location = useLocation();
  return <p data-probe>{JSON.stringify(location.state)}</p>;
}

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.reader.getBlock.mockResolvedValue({ timestamp: CHAIN_NOW });
  m.reader.readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
    const usdc = address.toLowerCase() === pinnedChain.tokens.usdc.address.toLowerCase();
    switch (functionName) {
      case 'symbol':
        return Promise.resolve(usdc ? 'USDC' : 'USDT');
      case 'decimals':
        return Promise.resolve(6);
      case 'balanceOf':
        return Promise.resolve(1_100_000_000n);
      case 'activeProposal':
        return Promise.resolve(`0x${'0'.repeat(64)}`);
      case 'destinationsOf':
        return Promise.resolve([DEST]);
      case 'destinationInfo':
        return Promise.resolve([true, CHAIN_NOW + 23n * 3600n + 12n * 60n, false]);
      default:
        return Promise.reject(new Error(`lectura inesperada: ${functionName}`));
    }
  });
  m.api.balances.mockRejectedValue(new Error('sin backend'));
  m.api.listRotations.mockResolvedValue({ items: [] });
  m.api.whitelist.mockResolvedValue({
    entries: [
      {
        id: 'e1',
        destination: DEST,
        label: 'Proveedor',
        status: 'ACTIVATING',
        activatesAt: null,
        activatedAt: null,
        origin: 'PLATFORM',
        addedTxHash: null,
      },
    ],
    requests: [],
  });
  m.api.operations.mockResolvedValue({ items: [], nextCursor: null });
  m.api.transfers.mockResolvedValue({ items: [], nextCursor: null });
  m.api.notifications.mockResolvedValue({ items: [requested], unread: 1, nextCursor: null });
  m.api.markNotificationRead.mockResolvedValue({ ...requested, readAt: '2026-10-19T10:01:00.000Z' });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function openHome(): Promise<HTMLElement> {
  view = await render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<OperatingHome ctx={ctx} />} />
        <Route path="/whitelist" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle(10);
  return view.container;
}

describe('inicio operativo', () => {
  it('alerta de un destino en activación con su nombre, la dirección completa, cuánto falta y la baja directa', async () => {
    const c = await openHome();
    const alert = c.querySelector(`[data-activating="${DEST}"]`);
    expect(alert?.textContent).toBe(
      `Un destino nuevo («Proveedor» ${groupAddress(DEST)}) se activa en 23 h 12 min: si no lo agregaste vos o si ` +
        'no es la dirección que esperabas, quitalo antes de que se active. Quitarlo',
    );
    await click(byText(c, 'a', 'Quitarlo'));
    expect(c.querySelector('[data-probe]')?.textContent).toBe(JSON.stringify({ remove: DEST }));
  });

  it('avisos in-app sin leer, con acceso a la pantalla y "Marcar como leído"', async () => {
    const c = await openHome();
    const panel = c.querySelector('[data-notifications]');
    expect(panel?.querySelector('h2')?.textContent).toBe('Avisos sin leer (1)');
    const item = panel?.querySelector('[data-notification="WHITELIST_REQUESTED"]');
    expect(item?.textContent).toContain(`Se pidió agregar a tu whitelist el destino «Proveedor» ${groupAddress(DEST)}`);
    // Una advertencia se ve como tal (no como un aviso informativo).
    expect(item?.getAttribute('data-tone')).toBe('warning');
    expect(item?.querySelector('a')?.getAttribute('href')).toBe('/whitelist');
    expect(item?.querySelector('time')?.textContent).toBe(new Date(requested.createdAt).toLocaleString('es-AR'));
    await click(byText(c, 'button', 'Marcar como leído'));
    await settle();
    expect(m.api.markNotificationRead).toHaveBeenCalledWith('n1');
    expect(c.querySelector('[data-notifications]')).toBeNull();
  });

  it('un aviso que ya dice cuándo pasó no repite la hora; la IP va sin notación de red', async () => {
    const login: AppNotification = {
      id: 'n2',
      walletId: null,
      type: 'NEW_LOGIN',
      payload: { occurredAt: '2026-10-19T10:00:00.000Z', app: 'WALLET', ipPrefix: '203.0.113.0/24' },
      readAt: null,
      createdAt: '2026-10-19T10:00:01.000Z',
    };
    m.api.notifications.mockResolvedValue({ items: [login], unread: 1, nextCursor: null });
    const c = await openHome();
    const item = c.querySelector('[data-notification="NEW_LOGIN"]');
    const at = new Date('2026-10-19T10:00:00.000Z').toLocaleString('es-AR');
    expect(item?.textContent).toContain(`Nuevo inicio de sesión en Wallet el ${at} desde 203.0.113.x.`);
    expect(item?.textContent).not.toContain('/24');
    expect(item?.querySelector('time')).toBeNull();
    expect(item?.getAttribute('data-tone')).toBe('info');
    expect(readableIpPrefix('2001:db8:1::/48')).toBe('2001:db8:1:…');
    expect(readableIpPrefix('algo')).toBe('algo');
  });

  it('la clave U desbloqueada se muestra completa y agrupada', async () => {
    const c = await openHome();
    const unlockedLine = [...c.querySelectorAll('[role="status"]')].find((s) =>
      s.textContent.startsWith('Wallet desbloqueada'),
    );
    expect(unlockedLine?.textContent).toBe(`Wallet desbloqueada (dirección de tu clave U: ${groupAddress(KEY)}).`);
  });
});
