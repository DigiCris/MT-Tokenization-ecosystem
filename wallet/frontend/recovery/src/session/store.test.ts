// P19 [F-KEY-07]/[F-SES-04]: la sesión de Recovery vive sólo en memoria. Se bloquea —R se descarta, la wallet externa se
// desconecta y la PlatformSession se revoca en el backend— por inactividad en pantallas sensibles (5 min), al vencer la
// PlatformSession (15 min), al salir o a pedido; fuera de las pantallas sensibles no cuenta la inactividad. Cuarta
// revisión de P17.MAN: un minuto antes del bloqueo por inactividad se avisa (sin pausar la cuenta), y una R que ya no
// se va a usar se descarta sin revocar la verificación.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/recovery-api.ts';
import type { UnlockedRecovery } from '../crypto/session.ts';
import type { ExternalSession } from '../external-wallet/types.ts';
import { currentSigner, INACTIVITY_MS, INACTIVITY_WARNING_MS, SessionStore, type PlatformSession } from './store.ts';

const user = { id: 'u1', email: 'ana@example.test' } as User;

function fakeApi(options: { me?: 'ok' | 'fail' } = {}) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      me: () => (options.me === 'fail' ? Promise.reject(new Error('401')) : Promise.resolve(user)),
      logout: () => {
        calls.push('logout');
        return Promise.resolve();
      },
      revokePlatformSession: (id: string) => {
        calls.push(`revoke:${id}`);
        return Promise.resolve();
      },
    },
  };
}

const recovery = {
  address: '0x00000000000000000000000000000000000000a2',
  envelope: { walletId: 'w1' },
} as unknown as UnlockedRecovery;

function platform(expiresInMs: number): PlatformSession {
  return {
    auth: { token: 't', sessionId: 'ps-1', key: {} as CryptoKey },
    view: { id: 'ps-1', expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
  } as PlatformSession;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cuenta', () => {
  it('lee la cuenta de la cookie; sin cuenta queda anónima', async () => {
    const ok = new SessionStore(fakeApi().api);
    await ok.refresh();
    expect(ok.snapshot()).toMatchObject({ status: 'account', user });
    const anonymous = new SessionStore(fakeApi({ me: 'fail' }).api);
    await anonymous.refresh();
    expect(anonymous.snapshot()).toMatchObject({ status: 'anonymous', user: null });
  });

  it('salir bloquea (revoca la PlatformSession) y cierra la sesión de la cuenta', async () => {
    const { api, calls } = fakeApi();
    const store = new SessionStore(api);
    store.signedIn(user);
    store.setPlatform(platform(900_000));
    await store.logout();
    expect(calls).toEqual(['revoke:ps-1', 'logout']);
    expect(store.snapshot()).toMatchObject({ status: 'anonymous', platform: null, lockReason: 'LOGOUT' });
  });
});

describe('bloqueos', () => {
  it('la PlatformSession vence sola y se revoca', () => {
    const { api, calls } = fakeApi();
    const store = new SessionStore(api);
    store.setPlatform(platform(900_000));
    vi.advanceTimersByTime(899_000);
    expect(store.snapshot().platform).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(store.snapshot()).toMatchObject({ platform: null, lockReason: 'EXPIRED' });
    expect(calls).toEqual(['revoke:ps-1']);
  });

  it('inactividad: 5 min en una pantalla sensible descartan R; cada interacción reinicia la cuenta', () => {
    const store = new SessionStore(fakeApi().api);
    const leave = store.enterSensitive();
    store.unlockRecovery(recovery);
    vi.advanceTimersByTime(INACTIVITY_MS - 1_000);
    store.touch();
    vi.advanceTimersByTime(INACTIVITY_MS - 1_000);
    expect(store.snapshot().recovery).toBe(recovery);
    vi.advanceTimersByTime(1_000);
    expect(store.snapshot()).toMatchObject({ recovery: null, lockReason: 'INACTIVITY' });
    leave();
  });

  it('fuera de las pantallas sensibles no cuenta la inactividad', () => {
    const store = new SessionStore(fakeApi().api);
    const leave = store.enterSensitive();
    store.unlockRecovery(recovery);
    leave();
    vi.advanceTimersByTime(INACTIVITY_MS * 3);
    expect(store.snapshot().recovery).toBe(recovery);
  });

  it('bloquear a pedido desconecta la wallet externa; sin nada abierto no cambia el estado', async () => {
    const disconnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const external = {
      address: '0x00000000000000000000000000000000000000e1',
      disconnect,
    } as unknown as ExternalSession;
    const store = new SessionStore(fakeApi().api);
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    store.lock('MANUAL');
    expect(listener).not.toHaveBeenCalled();
    store.connectExternal(external);
    store.lock('MANUAL');
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(store.snapshot()).toMatchObject({ external: null, lockReason: 'MANUAL' });
    unsubscribe();
  });
});

describe('aviso de inactividad (hallazgo 2 de la cuarta revisión)', () => {
  it('un minuto antes del bloqueo avisa; el aviso no pausa la cuenta y el bloqueo lo saca', () => {
    const store = new SessionStore(fakeApi().api);
    const leave = store.enterSensitive();
    store.unlockRecovery(recovery);
    vi.advanceTimersByTime(INACTIVITY_MS - INACTIVITY_WARNING_MS - 1_000);
    expect(store.snapshot().inactivityWarning).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(store.snapshot().inactivityWarning).toBe(true);
    vi.advanceTimersByTime(INACTIVITY_WARNING_MS);
    expect(store.snapshot()).toMatchObject({ recovery: null, lockReason: 'INACTIVITY', inactivityWarning: false });
    leave();
  });

  it('«Seguir usando Recovery» (o cualquier tecla o toque) reinicia la cuenta y saca el aviso', () => {
    const store = new SessionStore(fakeApi().api);
    const leave = store.enterSensitive();
    store.setPlatform(platform(900_000));
    vi.advanceTimersByTime(INACTIVITY_MS - INACTIVITY_WARNING_MS);
    expect(store.snapshot().inactivityWarning).toBe(true);
    store.touch();
    expect(store.snapshot().inactivityWarning).toBe(false);
    vi.advanceTimersByTime(INACTIVITY_MS - 1_000);
    expect(store.snapshot().platform).not.toBeNull();
    expect(store.snapshot().inactivityWarning).toBe(true);
    leave();
    // Fuera de las pantallas sensibles no hay aviso ni bloqueo.
    expect(store.snapshot().inactivityWarning).toBe(false);
    vi.advanceTimersByTime(INACTIVITY_MS);
    expect(store.snapshot().platform).not.toBeNull();
  });

  it('sin nada abierto no avisa', () => {
    const store = new SessionStore(fakeApi().api);
    const leave = store.enterSensitive();
    store.unlockRecovery(recovery);
    store.discardKey();
    vi.advanceTimersByTime(INACTIVITY_MS);
    expect(store.snapshot()).toMatchObject({ inactivityWarning: false, lockReason: null });
    leave();
  });
});

describe('descartar la clave sin bloquear', () => {
  it('R y la wallet externa se descartan; la verificación sigue y no cuenta como bloqueo', async () => {
    const disconnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const external = {
      address: '0x00000000000000000000000000000000000000e1',
      disconnect,
    } as unknown as ExternalSession;
    const { api, calls } = fakeApi();
    const store = new SessionStore(api);
    store.setPlatform(platform(900_000));
    store.unlockRecovery(recovery);
    store.discardKey();
    expect(store.snapshot()).toMatchObject({ recovery: null, lockReason: null });
    expect(store.snapshot().platform).not.toBeNull();
    store.connectExternal(external);
    store.discardKey();
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(store.snapshot().external).toBeNull();
    expect(calls).toEqual([]);
    // Sin nada que descartar no cambia el estado.
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    store.discardKey();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('firmante R', () => {
  it('la R interna desbloqueada antes que la wallet externa; sin ninguna, null', () => {
    const external = {
      address: '0x00000000000000000000000000000000000000e1',
      connectorId: 'injected',
    } as unknown as ExternalSession;
    expect(currentSigner({ recovery, external })?.kind).toBe('internal');
    expect(currentSigner({ recovery: null, external })).toMatchObject({ kind: 'external', walletId: null });
    expect(currentSigner({ recovery: null, external: null })).toBeNull();
  });
});
