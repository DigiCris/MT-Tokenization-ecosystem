// @vitest-environment jsdom
// N14 de la verificación de P17.MAN: en «Reemplazar Recovery», el paso de activación (que tiene el pedido y su secreto
// `k`) queda montado aunque la wallet se bloquee mientras el usuario crea R′ en Recovery. Bloqueada, la pantalla ofrece
// desbloquear ahí mismo (ir a /unlock la desmontaría) y no la verificación de la Safe; al desbloquear, el paso sigue con
// la sesión nueva, también para generar otro pedido. Los avisos de «otra R» reciben la R vigente leída del Guard (N5).
import { act, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAuth } from '../../api/request-signature.ts';
import type { WalletApi } from '../../api/wallet-api.ts';
import {
  LOCKED_AFTER_CONFIRMATION_TEXT,
  LOCKED_DURING_REPLACEMENT_TEXT,
} from '../../recovery-activation/activation.ts';
import { SessionProvider } from '../../session/context.tsx';
import { SessionStore } from '../../session/store.ts';
import { byText, click, render, settle, type Mounted } from '../../ui/dom.test-helper.ts';
import type { UnlockedWallet } from '../../unlock/unlock.ts';
import { ReplaceRecoveryPage } from './ReplaceRecoveryPage.tsx';

const SAFE: Address = getAddress('0x00000000000000000000000000000000000005af');
const U: Address = getAddress('0x00000000000000000000000000000000000000a1');
const R: Address = getAddress('0x00000000000000000000000000000000000000a2');
const S: Address = getAddress('0x00000000000000000000000000000000000000a3');

/** Lo que recibió el paso de activación (simulado) y cuántas veces se montó y desmontó. */
const m = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  mounts: 0,
  unmounts: 0,
  /** El paso espera una sesión para otro pedido (renewSession a la vista). */
  renewing: false,
  renewed: [] as string[],
}));

vi.mock('../../app/services.ts', () => ({ api: {}, chainReader: {} }));
vi.mock('../../config/index.ts', () => ({
  appConfig: { platformId: 'mt-default' },
  systemContracts: {
    contracts: { timelock: { name: 'RotationTimelock', address: '0x00000000000000000000000000000000000000d3' } },
  },
}));
vi.mock('../../operations/OperationReview.tsx', () => ({ OperationReview: () => null }));
vi.mock('../../unlock/UnlockForm.tsx', () => ({
  UnlockForm: ({ inPlace }: { inPlace?: boolean }) => <p data-unlock-form={String(inPlace === true)} />,
}));
vi.mock('../../safe/SafeGate.tsx', async () => {
  const { useSession } = await import('../../session/context.tsx');
  return {
    SafeGate: ({ children }: { children: (ctx: unknown) => ReactNode }) => {
      const { unlocked } = useSession();
      if (!unlocked) return <p data-safe-gate="locked">Desbloqueá tu wallet para operar.</p>;
      return (
        <>
          {children({
            wallet: { id: 'w1', safe: SAFE, status: 'ACTIVE', chainId: 8453, createdAt: '', activatedAt: null },
            unlocked,
            reader: {},
            state: { roles: { userKey: U, recoveryKey: R, executor: S } },
          })}
        </>
      );
    },
  };
});
vi.mock('../../recovery-activation/RecoveryActivationStep.tsx', async () => {
  const { useEffect } = await import('react');
  return {
    RecoveryActivationStep: (props: {
      renewSession?: (renewed: (platform: PlatformAuth) => void) => ReactNode;
      [key: string]: unknown;
    }) => {
      m.props = props;
      useEffect(() => {
        m.mounts += 1;
        return () => {
          m.unmounts += 1;
        };
      }, []);
      return (
        <div data-step="">
          {m.renewing &&
            props.renewSession?.((platform) => {
              m.renewed.push(platform.sessionId);
            })}
        </div>
      );
    },
  };
});

/** Una wallet desbloqueada con la PlatformSession `id` (vigente 15 minutos). */
function unlockedWith(id: string): UnlockedWallet {
  const now = Date.now();
  return {
    envelope: { keyAddress: U },
    encryptionKey: {},
    platform: { token: id, sessionId: id, key: {} },
    session: {
      id,
      scope: 'OPERATIONS',
      authMethod: 'OPAQUE_U',
      walletId: 'w1',
      safe: SAFE,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 900_000).toISOString(),
    },
  } as unknown as UnlockedWallet;
}

let view: Mounted | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('reemplazar la clave de recuperación con la wallet que se bloquea (N14)', () => {
  it('el paso sigue montado, se desbloquea en la misma pantalla y sigue con la sesión nueva', async () => {
    // Sin timers reales: el bloqueo lo dispara el test.
    const store = new SessionStore({ revokePlatformSession: () => Promise.resolve() } as unknown as WalletApi, {
      now: () => Date.now(),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    store.unlocked(unlockedWith('ps-1'));
    view = await render(
      <SessionProvider store={store}>
        <MemoryRouter initialEntries={['/security/recovery']}>
          <ReplaceRecoveryPage />
        </MemoryRouter>
      </SessionProvider>,
    );
    await settle();
    const c = view.container;
    await click(byText(c, 'button', 'Reemplazar mi clave de recuperación'));
    await settle();
    expect(m.mounts).toBe(1);
    expect(m.props).toMatchObject({ purpose: 'REPLACEMENT', walletId: 'w1', currentRecoveryKey: R });
    expect((m.props?.platform as PlatformAuth).sessionId).toBe('ps-1');

    // Se bloquea (p. ej. por inactividad) mientras se crea R′ en Recovery: el paso no se desmonta.
    m.renewing = true;
    await act(async () => {
      await store.lock('INACTIVITY');
    });
    await settle();
    expect(m.unmounts).toBe(0);
    expect(m.mounts).toBe(1);
    expect(c.querySelector('[data-replacement-locked]')?.textContent).toContain(LOCKED_DURING_REPLACEMENT_TEXT);
    // El desbloqueo está acá (sin nada que recargue la página), no el enlace a /unlock de la verificación de la Safe.
    expect(c.querySelector('[data-unlock-form="true"]')).not.toBeNull();
    expect(c.querySelector('[data-safe-gate]')).toBeNull();
    // Sin sesión vigente: otro pedido espera el desbloqueo.
    expect(m.props?.sessionExpiresAt).toBe(new Date(0).toISOString());
    expect(m.renewed).toEqual([]);

    // Desbloqueada otra vez: la misma instancia del paso, con la sesión nueva (y el pedido pendiente sale con ella).
    await act(async () => {
      store.unlocked(unlockedWith('ps-2'));
      await Promise.resolve();
    });
    await settle();
    expect(m.mounts).toBe(1);
    expect(m.unmounts).toBe(0);
    expect((m.props?.platform as PlatformAuth).sessionId).toBe('ps-2');
    expect(m.renewed).toEqual(['ps-2']);
    expect(c.querySelector('[data-replacement-locked]')).toBeNull();
    expect(c.textContent).toContain('Tu clave de recuperación (R)');

    // R′ confirmada (con la sesión de cuenta, aunque la wallet se bloquee): falta proponer el reemplazo, y un bloqueo
    // tampoco saca de la pantalla ni pierde la dirección confirmada.
    const confirmed = getAddress('0x00000000000000000000000000000000000000c4');
    await act(async () => {
      (m.props?.onConfirmed as (c: unknown) => void)({
        recoveryKey: confirmed,
        enrollmentId: 'e1',
        enrollmentNonce: null,
      });
      await Promise.resolve();
    });
    await settle();
    expect(m.unmounts).toBe(1);
    expect(byText(c, 'h2', 'Proponer el reemplazo')).toBeDefined();
    await act(async () => {
      await store.lock('INACTIVITY');
    });
    await settle();
    expect(c.querySelector('[data-replacement-locked]')?.textContent).toContain(LOCKED_AFTER_CONFIRMATION_TEXT);
    expect(c.querySelector('[data-safe-gate]')).toBeNull();
    await act(async () => {
      store.unlocked(unlockedWith('ps-3'));
      await Promise.resolve();
    });
    await settle();
    expect(byText(c, 'h2', 'Proponer el reemplazo')).toBeDefined();
    expect(c.querySelector(`[data-address="${confirmed}"]`)).not.toBeNull();
  });
});
