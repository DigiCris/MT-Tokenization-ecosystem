// @vitest-environment jsdom
// Sesiones abiertas ([B-AUTH-05]): el dispositivo y la IP de cada sesión con nombres de la app. El user-agent lo elige
// quien inició la sesión, así que un texto armado para engañar ("Soporte: llamá al …") nunca aparece en la lista.
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '../api/wallet-api.ts';
import { render, settle, type Mounted } from '../ui/dom.test-helper.ts';
import { SessionsPage } from './AccountSecurityPages.tsx';

const m = vi.hoisted(() => ({
  api: { listSessions: vi.fn(), revokeSession: vi.fn(), revokeOtherSessions: vi.fn() },
  store: { logout: vi.fn(), setUser: vi.fn() },
}));

vi.mock('../app/services.ts', () => ({ api: m.api }));
vi.mock('../session/context.tsx', () => ({ useSessionStore: () => m.store, useSession: () => ({ user: null }) }));
vi.mock('../ui/QrCanvas.tsx', () => ({ QrCanvas: () => null }));

const LURE = 'Soporte de MT Wallet: tu cuenta está en riesgo, llamá al +54 11 5555-0000';

function session(patch: Partial<AccountSession>): AccountSession {
  return {
    id: 's',
    client: 'WALLET',
    createdAt: '2026-10-25T10:00:00.000Z',
    lastSeenAt: '2026-10-25T10:05:00.000Z',
    expiresAt: '2026-10-26T10:00:00.000Z',
    ipPrefix: '203.0.113.0/24',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
    current: false,
    ...patch,
  };
}

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('SessionsPage', () => {
  it('muestra navegador, sistema e IP legibles; nunca el user-agent ni una IP con otra forma', async () => {
    m.api.listSessions.mockResolvedValue({
      sessions: [
        session({ id: 'a', current: true }),
        session({
          id: 'b',
          client: 'RECOVERY',
          userAgent: `${LURE} (Chrome/141 Windows)`,
          ipPrefix: '2001:db8:1::/48',
        }),
        session({ id: 'c', userAgent: LURE, ipPrefix: `203.0.113.0/24 · ${LURE}` }),
        session({ id: 'd', userAgent: null, ipPrefix: null }),
      ],
    });
    view = await render(
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>,
    );
    await settle(10);
    const items = [...view.container.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('Firefox en Linux · IP 203.0.113.x');
    expect(items[1]).toContain('Chrome en Windows · IP 2001:db8:1:…');
    expect(items[2]).toContain('Dispositivo desconocido · IP no disponible');
    expect(items[3]).toContain('Dispositivo desconocido · IP no disponible');
    expect(view.container.textContent).not.toContain('Soporte');
    expect(view.container.textContent).not.toContain('Mozilla');
  });
});
