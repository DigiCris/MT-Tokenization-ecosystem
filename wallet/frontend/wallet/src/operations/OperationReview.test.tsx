// @vitest-environment jsdom
// P18.MAN: el review dice qué se firma con el destino nombrado (el label del usuario entre «») y la dirección completa,
// la red y quién paga el gas, y guarda los detalles técnicos (contrato, función, argumentos con el monto en unidades
// mínimas y su equivalente, número de orden y el hash completo) en un desplegable. El segundo factor dice desde qué
// monto se pide (umbral de la policy que informa el backend) y por qué canal. Al terminar hay un cierre claro: título,
// lo hecho contado en pasado, el aviso de éxito (ya no se cancela; Confirmada y Final), el hash de la transacción con
// su enlace y cómo seguir; o el error con su motivo en texto. Un swap con el plazo vencido (o a menos de un minuto) ya no
// se ofrece para firmar: se cancela lo preparado y se vuelve a cotizar.
import type { ReactNode } from 'react';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import systemVector from '../../test/vectors/system.json';
import type { OperationStatus, PreparedOperation } from '../api/wallet-api.ts';
import { safeTxHash, type SafeTx, type VerifiedOperation } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { transferCall } from '../send/send.ts';
import { approveCall, swapCall } from '../swap/swap.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { byText, click, render, settle, type Mounted } from '../ui/dom.test-helper.ts';
import type { UnlockedWallet } from '../unlock/unlock.ts';
import type { ChainClock } from './describe.ts';
import { labelsOf } from './names.ts';
import { OperationReview } from './OperationReview.tsx';
import type * as SignModule from './sign.ts';

const m = vi.hoisted(() => ({
  api: {
    requestOperationTwoFactor: vi.fn(),
    confirmOperationTwoFactor: vi.fn(),
    operation: vi.fn(),
    cancelOperation: vi.fn(),
  },
  user: { email: 'ana@test.invalid', totpEnabled: false },
  signAndSubmit: vi.fn(),
  waitForOperation: vi.fn(),
}));

vi.mock('../app/services.ts', () => ({ api: m.api }));
vi.mock('../session/context.tsx', () => ({ useSession: () => ({ status: 'account', user: m.user }) }));
vi.mock('./sign.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SignModule>()),
  signAndSubmit: m.signAndSubmit,
  waitForOperation: m.waitForOperation,
}));

const system = systemVector as unknown as { contracts: Record<string, Address> };
const contract = (name: string) => ({ name, address: system.contracts[name] ?? '0x', codehash: '0x' as const });
const SAFE: Address = '0x00000000000000000000000000000000000000A1';
const DEST: Address = getAddress('0x6dfd2d7600000000000000000000000000003a23');
const decode = {
  safe: SAFE,
  chain: pinnedChain,
  system: {
    contracts: {
      guard: contract('securityGuard'),
      timelock: contract('rotationTimelock'),
      policyRegistry: contract('policyRegistry'),
      whitelist: contract('destinationWhitelist'),
      swapExecutor: contract('swapExecutor'),
      bootstrap: contract('safeBootstrap'),
      factory: contract('walletFactory'),
      moduleGuard: contract('denyAllModuleGuard'),
    },
  } as unknown as Pick<SystemContracts, 'contracts'>,
};
const unlocked = { platform: { sessionId: 's1' } } as unknown as UnlockedWallet;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;

function verified(
  tx: SafeTx,
  type: PreparedOperation['operationType'],
  extra: Partial<PreparedOperation> = {},
): VerifiedOperation {
  const hash = safeTxHash(8453, SAFE, tx);
  const operation: PreparedOperation = {
    operationId: `op-${type}`,
    groupId: null,
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
    safeTxHash: hash,
    typedData: {},
    decoded: {},
    requiresTwoFactor: false,
    expiresAt: '2026-10-19T10:15:00.000Z',
    ...extra,
  };
  return { operation, safeTx: tx, hash };
}

const send = (amount: bigint, extra: Partial<PreparedOperation> = {}) =>
  verified(transferCall(pinnedChain.tokens.usdc, DEST, amount, 5n), 'SEND', extra);

function status(id: string, state: OperationStatus['status'], patch: Partial<OperationStatus> = {}): OperationStatus {
  return {
    id,
    walletId: 'w1',
    status: state,
    operationType: 'SEND',
    groupId: null,
    safeNonce: '5',
    safeTxHash: TX_HASH,
    txHash: state === 'MINED' ? TX_HASH : null,
    blockNumber: null,
    blockHash: null,
    confirmations: { safe: 0, finalized: false },
    failureReason: state === 'FAILED_FINAL' ? 'POLICY_REJECTED: DEADLINE_INVALID' : null,
    lastErrorCode: null,
    blockedReason: null,
    requiresTwoFactor: false,
    expiresAt: null,
    cancelsOperationId: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    history: [],
    ...patch,
  };
}

/** Las dos SafeTx de un swap con el plazo dado (segundos de la cadena). */
function swapPair(deadline: bigint): VerifiedOperation[] {
  const executor = decode.system.contracts.swapExecutor.address;
  const usdc = pinnedChain.tokens.usdc.address;
  return [
    verified(approveCall(usdc, executor, 20_000_000n, 5n), 'SWAP_APPROVE'),
    verified(
      swapCall(executor, { tokenIn: usdc, amountIn: 20_000_000n, minAmountOut: 19_940_000n, deadline }, 6n),
      'SWAP',
    ),
  ];
}

let view: Mounted | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.user.totpEnabled = false;
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.useRealTimers();
});

interface ReviewProps {
  doneTitle?: string;
  result?: ReactNode;
  clock?: ChainClock | null;
  summary?: ReactNode | ((success: boolean) => ReactNode);
  onRequote?: () => void;
}

async function review(items: VerifiedOperation[], props: ReviewProps = {}) {
  const onSettled = vi.fn();
  const onCancel = vi.fn();
  view = await render(
    <MemoryRouter>
      <OperationReview
        title="Revisá el envío"
        {...props}
        items={items}
        unlocked={unlocked}
        decode={decode}
        labels={labelsOf([{ address: DEST, label: 'Cuenta de Ana' }])}
        onSettled={onSettled}
        onCancel={onCancel}
        doneActions={<button type="button">Hacer otro envío</button>}
      />
    </MemoryRouter>,
  );
  return { c: view.container, onSettled, onCancel };
}

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')].map((b) => b.textContent);

describe('review de una operación', () => {
  it('qué se firma: monto destacado, destino nombrado con la dirección completa, red y gas, y detalles técnicos', async () => {
    const item = send(1_500_000n);
    const { c } = await review([item]);
    expect(c.querySelector('.review__what')?.textContent).toBe(
      `Enviar 1,50 USDC a «Cuenta de Ana» ${groupAddress(DEST)}`,
    );
    expect(c.querySelector('.review__amount')?.textContent).toBe('1,50 USDC');
    expect(c.textContent).toContain('Red: Base. El gas de la red lo paga la plataforma: no se descuenta de tu saldo.');
    const details = c.querySelector('details.details');
    expect(details?.querySelector('summary')?.textContent).toBe('Detalles técnicos');
    expect(details?.textContent).toMatch(/transfer\(address \w+, uint256 \w+\)/);
    // El monto como lo recibe el contrato, aclarado y con su equivalente.
    expect(details?.querySelector('[data-argument="amount"]')?.textContent).toBe(
      '1500000 = 1,50 USDC (el contrato recibe el monto en unidades mínimas: USDC tiene 6 decimales)',
    );
    expect(details?.textContent).toContain('Número de orden en tu Safe (nonce)5');
    expect(details?.querySelector(`[data-hash="${item.hash}"]`)?.textContent).toBe(item.hash);
    expect(byText(c, 'button', 'Firmar con tu clave U')).toBeTruthy();
  });

  it('segundo factor por email: el umbral de la policy, qué comparar en el email y el botón que dice el canal', async () => {
    const { c } = await review([send(1_000_000_000n, { requiresTwoFactor: true, twoFactorThreshold: '1000000000' })]);
    expect(c.textContent).toContain('Los envíos de 1.000 USDC o más necesitan un segundo factor.');
    const compare = `antes de escribirlo, comprobá que el email muestre 1.000,00 USDC y el destino ${groupAddress(DEST)}, lo mismo que ves acá.`;
    expect(c.textContent).toContain(`Te vamos a mandar un código por email a ana@test.invalid: ${compare}`);
    expect([...c.querySelectorAll('button')].some((b) => b.textContent.startsWith('Firmar'))).toBe(false);
    m.api.requestOperationTwoFactor.mockResolvedValue({ method: 'EMAIL', challengeId: 'c1', expiresAt: 'x' });
    await click(byText(c, 'button', 'Pedir el código por email'));
    await settle();
    expect(c.textContent).toContain(`Te mandamos un código por email a ana@test.invalid: ${compare}`);
    expect(byText(c, 'label', 'Código que te mandamos por email')).toBeTruthy();
    expect(byText(c, 'button', 'Confirmar el código')).toBeTruthy();
  });

  it('segundo factor con la app de autenticación (TOTP activo); sin umbral informado no inventa un monto', async () => {
    m.user.totpEnabled = true;
    const { c } = await review([send(1_200_000_000n, { requiresTwoFactor: true })]);
    expect(c.textContent).toContain('Esta operación necesita un segundo factor por su monto.');
    expect(c.textContent).toContain('Lo confirmás con el código de 6 dígitos de tu app de autenticación.');
    expect(byText(c, 'button', 'Ingresar el código de mi app')).toBeTruthy();
  });

  it('éxito: título final, lo hecho en pasado, aviso sin "revertir", hash con su enlace y cómo seguir', async () => {
    m.signAndSubmit.mockResolvedValue(status('op-SEND', 'USER_SIGNED'));
    m.waitForOperation.mockImplementation(
      (_api: unknown, id: string, options: { onUpdate?: (s: OperationStatus) => void }) => {
        const mined = status(id, 'MINED');
        options.onUpdate?.(mined);
        return Promise.resolve(mined);
      },
    );
    const summary = vi.fn((success: boolean) => <p data-summary>{success ? 'hecho' : 'por hacer'}</p>);
    const { c, onSettled } = await review([send(1_500_000n)], {
      doneTitle: 'Envío realizado',
      result: <p data-result>Comprobado al terminar</p>,
      summary,
    });
    expect(c.querySelector('[data-summary]')?.textContent).toBe('por hacer');
    expect(c.textContent).not.toContain('Hacer otro envío');
    expect(c.querySelector('[data-result]')).toBeNull();
    await click(byText(c, 'button', 'Firmar con tu clave U'));
    await settle();
    expect(c.querySelector('#review-title')?.textContent).toBe('Envío realizado');
    // Lo que muestra la pantalla final ya pasó: en pasado, no como algo por firmar.
    expect(c.querySelector('.review__what')?.textContent).toBe(
      `Enviaste 1,50 USDC a «Cuenta de Ana» ${groupAddress(DEST)}`,
    );
    expect(c.querySelector('[data-summary]')?.textContent).toBe('hecho');
    expect(c.textContent).toContain('El gas de la red lo pagó la plataforma: no se descontó de tu saldo.');
    expect(c.querySelector('[data-status="MINED"]')?.textContent).toBe('Estado: Incluida en un bloque');
    // El hash de la transacción completo, y el enlace al explorador.
    expect(c.querySelector(`.review__tx [data-tx="${TX_HASH}"] code`)?.textContent).toBe(TX_HASH);
    expect(byText(c, 'a', 'ver en el explorador de bloques').getAttribute('href')).toBe(
      `https://basescan.org/tx/${TX_HASH}`,
    );
    const notice = c.querySelector('.notice--success');
    expect(notice?.textContent).toContain(
      'Listo: la operación ya está incluida en un bloque de Base y ya no se puede cancelar.',
    );
    expect(notice?.textContent).toContain(
      'pasa a Confirmada y, en unos 20 minutos, a Final (desde ahí, ni una reorganización de la red puede revertirla).',
    );
    expect(notice?.textContent).not.toMatch(/ya no se puede revertir/);
    expect(byText(c, 'button', 'Hacer otro envío')).toBeTruthy();
    // Lo que se comprueba al terminar queda dentro del review (p. ej. el permiso que quedó después de un swap).
    expect(c.querySelector('article [data-result]')?.textContent).toBe('Comprobado al terminar');
    expect(onSettled).toHaveBeenCalledWith([status('op-SEND', 'MINED')]);
    expect([...c.querySelectorAll('button')].some((b) => b.textContent === 'Cancelar')).toBe(false);
  });

  it('una operación que no se ejecuta: error claro con el motivo en texto (sin códigos), sin título de éxito', async () => {
    m.signAndSubmit.mockResolvedValue(status('op-SEND', 'USER_SIGNED'));
    m.waitForOperation.mockImplementation(
      (_api: unknown, id: string, options: { onUpdate?: (s: OperationStatus) => void }) => {
        const failed = status(id, 'FAILED_FINAL');
        options.onUpdate?.(failed);
        return Promise.resolve(failed);
      },
    );
    const { c } = await review([send(1_500_000n)], { doneTitle: 'Envío realizado' });
    await click(byText(c, 'button', 'Firmar con tu clave U'));
    await settle();
    expect(c.querySelector('#review-title')?.textContent).toBe('Revisá el envío');
    // Lo intentado sigue contado como lo que se iba a hacer (no se ejecutó).
    expect(c.querySelector('.review__what')?.textContent).toMatch(/^Enviar 1,50 USDC/);
    expect(c.querySelector('[data-status="FAILED_FINAL"]')?.textContent).toBe(
      'Estado: Falló (no cumple las reglas de la plataforma: venció el plazo del swap)',
    );
    expect(c.textContent).not.toMatch(/POLICY_REJECTED|DEADLINE_INVALID/);
    expect(c.querySelector('.notice--error')?.textContent).toContain('La operación no se ejecutó.');
    expect(byText(c, 'button', 'Hacer otro envío')).toBeTruthy();
  });

  it('dos operaciones (swap): numeradas, el permiso nombra al contrato de swap y el botón dice que son 2', async () => {
    const executor = decode.system.contracts.swapExecutor.address;
    const { c } = await review(swapPair(1_800_000_600n));
    const steps = [...c.querySelectorAll('.review__step')].map((s) => s.textContent);
    expect(steps).toEqual(['Operación 1 de 2', 'Operación 2 de 2']);
    const [first, second] = [...c.querySelectorAll('.review__what')].map((w) => w.textContent);
    expect(first).toBe(
      `Permitir que el contrato de swap de la plataforma ${groupAddress(executor)} use exactamente 20,00 USDC de tu ` +
        'Safe, sólo para este swap (al ejecutarse el swap el permiso vuelve a 0)',
    );
    expect(second).toMatch(/^Cambiar 20,00 USDC por al menos 19,94 USDT, que llegan a tu Safe; vence /);
    expect(byText(c, 'button', 'Firmar las 2 operaciones con tu clave U')).toBeTruthy();
    // Detalles técnicos del swap: montos en unidades mínimas con su equivalente y el plazo con su fecha.
    const swapDetails = c.querySelectorAll('details.details')[1];
    expect(swapDetails?.querySelector('[data-argument="amountIn"]')?.textContent).toContain('= 20,00 USDC');
    expect(swapDetails?.querySelector('[data-argument="minAmountOut"]')?.textContent).toContain('= 19,94 USDT');
    expect(swapDetails?.querySelector('[data-argument="deadline"]')?.textContent).toMatch(
      /^1800000600 = .* \(hora de la cadena, en segundos desde 1970\)$/,
    );
  });
});

describe('swap con plazo', () => {
  const CHAIN = 1_800_000_000_000;
  const DEVICE = Date.UTC(2026, 9, 19, 10, 0, 0);
  const deadlineIn = (ms: number) => BigInt((CHAIN + ms) / 1000);

  it('vencido: no se ofrece firmar; "Volver a cotizar" cancela lo preparado en el backend y vuelve a cotizar', async () => {
    m.api.operation.mockResolvedValue({ status: 'CREATED' });
    m.api.cancelOperation.mockResolvedValue({});
    const onRequote = vi.fn();
    const { c, onCancel } = await review(swapPair(deadlineIn(-30_000)), {
      clock: { chainMs: CHAIN, deviceMs: DEVICE },
      onRequote,
    });
    expect([...c.querySelectorAll('.review__what')][1]?.textContent).toMatch(/venció a las .*: volvé a cotizar$/);
    expect(buttons(c).some((b) => b.startsWith('Firmar'))).toBe(false);
    expect(c.querySelector('[data-expired] .notice--warning')?.textContent).toBe(
      'Venció el plazo del swap: ya no se puede firmar. Volvé a cotizar: la app cancela lo preparado y pide una ' +
        'cotización nueva.',
    );
    await click(byText(c, 'button', 'Volver a cotizar'));
    await settle();
    expect(m.api.cancelOperation).toHaveBeenCalledTimes(2);
    expect(m.api.cancelOperation).toHaveBeenCalledWith(unlocked.platform, 'op-SWAP_APPROVE');
    expect(m.api.cancelOperation).toHaveBeenCalledWith(unlocked.platform, 'op-SWAP');
    expect(onRequote).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('en el último minuto tampoco se firma (no daría tiempo a ejecutarlo antes del plazo)', async () => {
    const { c } = await review(swapPair(deadlineIn(30_000)), { clock: { chainMs: CHAIN, deviceMs: DEVICE } });
    expect(buttons(c).some((b) => b.startsWith('Firmar'))).toBe(false);
    expect(c.querySelector('[data-expired] .notice--warning')?.textContent).toMatch(
      /^Queda menos de un minuto del plazo del swap: ya no da tiempo a firmarlo\./,
    );
    // Sin onRequote, volver a cotizar es volver al formulario (onCancel).
    expect(byText(c, 'button', 'Volver a cotizar')).toBeTruthy();
  });

  it('el botón de firma desaparece cuando vence el plazo, sin esperar la próxima lectura de la cadena', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(DEVICE);
    const { c } = await review(swapPair(deadlineIn(2 * 60_000)), { clock: { chainMs: CHAIN, deviceMs: DEVICE } });
    expect(byText(c, 'button', 'Firmar las 2 operaciones con tu clave U')).toBeTruthy();
    expect([...c.querySelectorAll('.review__what')][1]?.textContent).toMatch(/vence en 2 min/);
    await act(async () => {
      vi.setSystemTime(DEVICE + 61_000);
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(buttons(c).some((b) => b.startsWith('Firmar'))).toBe(false);
    expect(byText(c, 'button', 'Volver a cotizar')).toBeTruthy();
  });

  it('sin la hora de la cadena no se bloquea (el backend y el contrato igual controlan el plazo)', async () => {
    const { c } = await review(swapPair(1n), { clock: null });
    expect(byText(c, 'button', 'Firmar las 2 operaciones con tu clave U')).toBeTruthy();
    expect(c.querySelector('[data-expired]')).toBeNull();
  });
});
