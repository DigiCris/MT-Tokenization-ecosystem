// @vitest-environment jsdom
// P18.MAN (B1): cada operación de la actividad dice qué fue con dos puntos ("Alta en la whitelist: «Proveedor» 0x…",
// "Envío: 1.000,00 USDC a …", sin un "de" que se lea como origen), su estado con el matiz que importa ("Cancelada antes
// de firmar") y el motivo en texto si no se ejecutó, y el hash de la transacción además del enlace al explorador. La
// ayuda de estados cubre todos los que se pueden ver.
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationStatus, Transfer } from '../api/wallet-api.ts';
import { STATE_HELP } from '../operations/describe.ts';
import { addressNames, labelsOf, shownLabels } from '../operations/names.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { render, type Mounted } from '../ui/dom.test-helper.ts';
import { mergeActivity } from './activity.ts';
import { ActivityList } from './ActivityList.tsx';
import { StateHelp } from './ActivityPage.tsx';

// La página de actividad trae la config embebida del build y los servicios de la app: acá sólo se usa su ayuda.
vi.mock('../config/index.ts', () => ({ appConfig: { platformId: 'mt-default' }, systemContracts: { contracts: {} } }));
vi.mock('../app/services.ts', () => ({ api: {}, chainReader: {} }));

const DEST: Address = getAddress('0xf0a10000000000000000000000000000000076a3');
const TX = `0x${'ab'.repeat(32)}` as const;
const nameOf = addressNames({}, shownLabels(labelsOf([{ address: DEST, label: 'Proveedor' }])));

const op = (id: string, patch: Partial<OperationStatus>) =>
  ({
    id,
    createdAt: '2026-10-19T10:00:00Z',
    txHash: null,
    status: 'FINALIZED',
    operationType: 'SEND',
    failureReason: null,
    lastErrorCode: null,
    history: [],
    ...patch,
  }) as OperationStatus;

let view: Mounted | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function list(operations: OperationStatus[], transfers: Transfer[] = []): Promise<HTMLElement> {
  view = await render(
    <MemoryRouter>
      <ActivityList items={mergeActivity(operations, transfers)} nameOf={nameOf} />
    </MemoryRouter>,
  );
  return view.container;
}

describe('lista de actividad', () => {
  it('qué fue cada operación, con dos puntos y sin un "de" que se lea como origen', async () => {
    const c = await list([
      op('add', {
        operationType: 'WHITELIST_ADD',
        decoded: { destination: DEST },
        txHash: TX,
        history: [{ status: 'MINED', at: '2026-10-19T10:01:00Z' }],
      }),
      op('send', {
        status: 'CANCELLED',
        failureReason: 'USER_CANCELLED',
        decoded: { token: 'USDC', amount: '1000000000', destination: DEST },
        history: [
          { status: 'CREATED', at: '2026-10-19T09:00:00Z' },
          { status: 'CANCELLED', at: '2026-10-19T09:01:00Z' },
        ],
        createdAt: '2026-10-19T09:00:00Z',
      }),
    ]);
    const [added, cancelled] = [...c.querySelectorAll('li[data-kind="operation"]')];
    expect(added?.textContent).toMatch(
      new RegExp(`^Alta en la whitelist: «Proveedor» ${groupAddress(DEST)} · Final · `),
    );
    // El hash de la transacción completo, además del enlace.
    expect(added?.querySelector(`[data-tx="${TX}"] code`)?.textContent).toBe(TX);
    expect(added?.querySelector('a')?.getAttribute('href')).toBe(`https://basescan.org/tx/${TX}`);
    expect(cancelled?.textContent).toMatch(
      new RegExp(
        `^Envío: 1\\.000,00 USDC a «Proveedor» ${groupAddress(DEST)} · Cancelada antes de firmar · preparada el `,
      ),
    );
    expect(cancelled?.querySelector('[data-tx]')).toBeNull();
  });

  it('una operación fallida dice por qué, en texto', async () => {
    const c = await list([
      op('swap', {
        operationType: 'SWAP',
        status: 'FAILED_FINAL',
        failureReason: 'POLICY_REJECTED: DEADLINE_INVALID',
        lastErrorCode: 'POLICY_REJECTED',
        decoded: { tokenIn: 'USDC', tokenOut: 'USDT', amount: '20000000', minAmountOut: '19940000' },
      }),
    ]);
    const item = c.querySelector('li[data-kind="operation"]');
    expect(item?.querySelector('[data-state]')?.textContent).toBe('Falló');
    expect(item?.querySelector('[data-reason]')?.textContent).toBe(
      ' (no cumple las reglas de la plataforma: venció el plazo del swap)',
    );
    expect(item?.textContent).not.toMatch(/POLICY_REJECTED|DEADLINE_INVALID/);
  });

  it('un transfer recibido: de quién, con el hash de su transacción', async () => {
    const c = await list(
      [],
      [
        {
          id: 't1',
          createdAt: '2026-10-19T10:00:00Z',
          direction: 'IN',
          txHash: TX,
          token: 'USDC',
          amount: '8000000',
          counterparty: DEST,
        } as Transfer,
      ],
    );
    const item = c.querySelector('li[data-kind="transfer"]');
    expect(item?.textContent).toMatch(new RegExp(`^Recibiste 8,00 USDC de «Proveedor» ${groupAddress(DEST)} · `));
    expect(item?.querySelector(`[data-tx="${TX}"]`)).not.toBeNull();
  });

  it('la ayuda de estados cubre todos los que se pueden ver', async () => {
    view = await render(<StateHelp />);
    const terms = [...view.container.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms).toHaveLength(STATE_HELP.length + 1);
    expect(terms).toEqual(expect.arrayContaining(['Preparada', 'Falló', 'Cancelada', 'Venció sin firmar', 'Final']));
    expect(terms).toContain('Cancelada antes de firmar');
  });
});
