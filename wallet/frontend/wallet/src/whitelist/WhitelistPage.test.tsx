// @vitest-environment jsdom
// P18.MAN: el alta en la whitelist alterna dos formularios (pedido del código y confirmación): el campo del código
// arranca vacío (React no reutiliza el campo del nombre), la confirmación pide comparar la dirección con la del email y
// con la que pasó el destinatario por otro medio, sin copiarla de la app ni del email (ESC-16), y "Empezar de nuevo"
// vuelve al pedido con los campos vacíos. Un nombre que imita uno de la app no se acepta y los labels se muestran
// entre «». Firmada el alta, la pantalla la cuenta en pasado. La alerta del inicio abre directamente la baja del destino
// en activación, con el review nombrando el destino; en la lista, la alerta va antes del botón y cerrada con punto.
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationStatus, PreparedOperation, WhitelistRequest } from '../api/wallet-api.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';
import type * as SignModule from '../operations/sign.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { byLabel, byText, click, render, settle, submit, typeInto, type Mounted } from '../ui/dom.test-helper.ts';
import { addDestinationCall, removeDestinationCall } from './whitelist.ts';
import { WhitelistPage } from './WhitelistPage.tsx';

const m = vi.hoisted(() => ({
  SAFE: '0x00000000000000000000000000000000000000A1' as const,
  WHITELIST: '0x00000000000000000000000000000000000000d1' as const,
  api: {
    whitelist: vi.fn(),
    requestWhitelistDestination: vi.fn(),
    confirmWhitelistRequest: vi.fn(),
    removeWhitelistDestination: vi.fn(),
    operation: vi.fn(),
    cancelOperation: vi.fn(),
  },
  reader: { readContract: vi.fn(), getBlock: vi.fn() },
  signAndSubmit: vi.fn(),
  waitForOperation: vi.fn(),
}));

vi.mock('../app/services.ts', () => ({ api: m.api, chainReader: m.reader }));
vi.mock('../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: {
    contracts: {
      whitelist: { name: 'DestinationWhitelist', address: m.WHITELIST, codehash: '0x' },
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
      wallet: { id: 'w1', safe: m.SAFE, status: 'ACTIVE', chainId: 8453, createdAt: '', activatedAt: null },
      unlocked: { platform: { sessionId: 's1' } },
      reader: m.reader,
      state: {},
    }),
}));
vi.mock('../operations/sign.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SignModule>()),
  signAndSubmit: m.signAndSubmit,
  waitForOperation: m.waitForOperation,
}));

const DEST: Address = getAddress('0xf0a10000000000000000000000000000000076a3');
const CHAIN_NOW = 1_800_000_000n;

function prepared(tx: SafeTx, type: PreparedOperation['operationType']): PreparedOperation {
  return {
    operationId: `op-${type}`,
    groupId: null,
    walletId: 'w1',
    safe: m.SAFE,
    chainId: 8453,
    operationType: type,
    safeTx: {
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce.toString(),
    },
    safeTxHash: safeTxHash(8453, m.SAFE, tx),
    typedData: {},
    decoded: { destination: DEST },
    requiresTwoFactor: false,
    expiresAt: '2026-10-19T10:15:00.000Z',
  };
}

const request: WhitelistRequest = {
  id: 'r1',
  walletId: 'w1',
  destination: DEST,
  label: 'Proveedor',
  status: 'PENDING_CHALLENGE',
  challengeExpiresAt: null,
  operationId: null,
  failureReason: null,
  createdAt: '2026-10-19T10:00:00.000Z',
};

/** La whitelist on-chain: los destinos dados, todavía en activación (se activan en 23 h). */
function chainWith(destinations: Address[]) {
  m.reader.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === 'destinationsOf') return Promise.resolve(destinations);
    if (functionName === 'destinationInfo') return Promise.resolve([true, CHAIN_NOW + 23n * 3600n, false]);
    if (functionName === 'nonce') return Promise.resolve(5n);
    return Promise.reject(new Error(`lectura inesperada: ${functionName}`));
  });
}

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.reader.getBlock.mockResolvedValue({ timestamp: CHAIN_NOW });
  m.api.whitelist.mockResolvedValue({ entries: [], requests: [] });
  chainWith([]);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function openWhitelist(state?: unknown): Promise<HTMLElement> {
  view = await render(
    <MemoryRouter initialEntries={[{ pathname: '/whitelist', state }]}>
      <WhitelistPage />
    </MemoryRouter>,
  );
  await settle(10);
  return view.container;
}

async function requestCode(c: HTMLElement, label: string): Promise<void> {
  await typeInto(byLabel(c, 'Dirección en Base'), DEST.toLowerCase());
  const name = byLabel(c, 'Nombre (para reconocerlo)');
  await typeInto(name, label);
  await submit(name.form!);
  await settle();
}

describe('alta en la whitelist', () => {
  it('el código del email arranca vacío, con la dirección para comparar con el email y con la fuente; "Empezar de nuevo" limpia todo', async () => {
    m.api.requestWhitelistDestination.mockResolvedValue(request);
    const c = await openWhitelist();
    await requestCode(c, 'Proveedor');

    expect(m.api.requestWhitelistDestination).toHaveBeenCalledWith({ sessionId: 's1' }, 'w1', {
      destination: DEST,
      label: 'Proveedor',
    });
    const code = byLabel(c, 'Código del email (8 dígitos)');
    expect(code.value).toBe('');
    expect(c.querySelector('input[name="label"]')).toBeNull();
    expect(c.textContent).toContain('Te mandamos un código por email a ana@test.invalid.');
    // ESC-16: comparar sólo app y email no alcanza si la dirección se cambió antes de llegar a la app.
    expect(c.textContent).toContain(
      'Antes de escribir el código, compará los 10 grupos de esta dirección con la del email y con la que te pasó el ' +
        'destinatario por otro medio (no la copies de esta pantalla ni del email):',
    );
    expect(c.querySelector('.notice--warning strong')?.textContent).toBe('«Proveedor»');
    expect(c.querySelector(`[data-address="${DEST}"]`)?.textContent).toBe(groupAddress(DEST));

    await typeInto(code, '12345678');
    await click(byText(c, 'button', 'Empezar de nuevo'));
    expect(byLabel(c, 'Dirección en Base').value).toBe('');
    expect(byLabel(c, 'Nombre (para reconocerlo)').value).toBe('');
  });

  it('un nombre que imita uno de la app no se acepta (y no se pide el código)', async () => {
    const c = await openWhitelist();
    await requestCode(c, 'Tu Safe');
    expect(m.api.requestWhitelistDestination).not.toHaveBeenCalled();
    expect(c.querySelector('.notice--error')?.textContent).toBe(
      '«Tu Safe» es un nombre que la app usa para sus propias direcciones (como «tu Safe»): elegí otro.',
    );
    expect(byLabel(c, 'Nombre (para reconocerlo)')).toBeTruthy();
  });

  it('firmada el alta, la pantalla la cuenta en pasado (no repite lo que había que comparar)', async () => {
    m.api.requestWhitelistDestination.mockResolvedValue(request);
    m.api.confirmWhitelistRequest.mockResolvedValue({
      request: { ...request, status: 'AWAITING_SIGNATURE' },
      operation: prepared(addDestinationCall(m.WHITELIST, DEST, 5n), 'WHITELIST_ADD'),
    });
    const mined = { id: 'op-WHITELIST_ADD', status: 'MINED', txHash: null, failureReason: null } as OperationStatus;
    m.signAndSubmit.mockResolvedValue({ ...mined, status: 'USER_SIGNED' });
    m.waitForOperation.mockImplementation(
      (_api: unknown, _id: string, options: { onUpdate?: (s: OperationStatus) => void }) => {
        options.onUpdate?.(mined);
        return Promise.resolve(mined);
      },
    );
    const c = await openWhitelist();
    await requestCode(c, 'Proveedor');
    const code = byLabel(c, 'Código del email (8 dígitos)');
    await typeInto(code, '12345678');
    await submit(code.form!);
    await settle();
    expect(c.querySelector('#review-title')?.textContent).toBe('Revisá el alta del destino');
    expect(c.querySelector('[data-review] > p')?.textContent).toMatch(
      /^Tiene que ser la misma dirección que mostraba el email y la que te pasó el destinatario por otro medio \(no la copies de esta pantalla ni del email\)\./,
    );
    expect(c.querySelector('.review__what')?.textContent).toBe(
      `Agregar a tu whitelist el destino «Proveedor» ${groupAddress(DEST)} (se activa 24 h después)`,
    );
    await click(byText(c, 'button', 'Firmar con tu clave U'));
    await settle();
    expect(c.querySelector('#review-title')?.textContent).toBe('Destino agregado');
    const summary = c.querySelector('[data-review] > p')?.textContent ?? '';
    expect(summary).toMatch(/^El alta ya está en un bloque de Base: el destino se activa en 24 h/);
    expect(summary).not.toContain('Tiene que ser la misma dirección');
    expect(c.querySelector('.review__what')?.textContent).toBe(
      `Agregaste a tu whitelist el destino «Proveedor» ${groupAddress(DEST)} (se activa 24 h después de incluirse en ` +
        'un bloque)',
    );
  });

  it('la alerta del inicio abre la baja del destino en activación, una sola vez y con el destino nombrado', async () => {
    chainWith([DEST]);
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
    m.api.removeWhitelistDestination.mockResolvedValue(
      prepared(removeDestinationCall(m.WHITELIST, DEST, 5n), 'WHITELIST_REMOVE'),
    );
    const c = await openWhitelist({ remove: DEST });
    expect(m.api.removeWhitelistDestination).toHaveBeenCalledTimes(1);
    expect(m.api.removeWhitelistDestination).toHaveBeenCalledWith({ sessionId: 's1' }, 'w1', DEST);
    expect(c.querySelector('#review-title')?.textContent).toBe('Revisá la baja del destino');
    expect(c.querySelector('.review__what')?.textContent).toBe(
      `Quitar de tu whitelist el destino «Proveedor» ${groupAddress(DEST)}`,
    );
    // La lista sigue arriba: el label entre «», cuánto falta cerrado con punto y la alerta antes del botón.
    const row = c.querySelector(`li[data-destination="${DEST}"]`);
    expect(row?.textContent).toBe(
      `«Proveedor» ${groupAddress(DEST)} · se activa en 23 h 0 min. Si no lo agregaste vos o no es la dirección que ` +
        'esperabas, quitalo antes de que se active. Quitar',
    );
    expect(row?.querySelector('[data-activation-alert]')?.textContent).toContain('Si no lo agregaste vos');
  });
});
