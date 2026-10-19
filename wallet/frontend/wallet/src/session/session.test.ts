// [F-SES-04]/[F-KEY-05]: estado de sesión — cuenta y wallet desde la API (sin sesión de cuenta, anónimo), bloqueo al
// vencer la PlatformSession y tras 5 minutos sin interacción sólo en pantallas sensibles, revocación en el backend al
// bloquear y logout tolerante a una sesión ya cerrada. Step-up: la PlatformSession tiene que ser del scope pedido.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem.ts';
import { generateSessionKey } from '../api/session-key.ts';
import type { PlatformSessionView, User, WalletApi, WalletView } from '../api/wallet-api.ts';
import type { UnlockedWallet } from '../unlock/unlock.ts';
import { codeExpiryText, finishStepUp, isLive, startStepUp } from './step-up.ts';
import { INACTIVITY_LOCK_MS, SessionStore } from './store.ts';

const user: User = {
  id: 'u1',
  email: 'a@b.test',
  emailVerified: true,
  totpEnabled: false,
  locale: 'es',
  timeZone: 'UTC',
  createdAt: new Date().toISOString(),
};
const wallet: WalletView = { id: 'w1', status: 'ACTIVE', chainId: 8453, safe: null, createdAt: '', activatedAt: null };
const unauthenticated = () =>
  new ApiError({ type: 'x', title: 'Autenticación requerida', status: 401, code: 'UNAUTHENTICATED', requestId: 'r' });

async function unlockedFor(minutes: number): Promise<UnlockedWallet> {
  const session: PlatformSessionView = {
    id: 'ps1',
    scope: 'OPERATIONS',
    authMethod: 'OPAQUE_U',
    walletId: 'w1',
    safe: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  return {
    envelope: {} as UnlockedWallet['envelope'],
    encryptionKey: {} as CryptoKey,
    platform: { token: 't', sessionId: 'ps1', key: await generateSessionKey() },
    session,
  };
}

function api(overrides: Partial<Record<keyof WalletApi, unknown>> = {}) {
  return {
    me: vi.fn(() => Promise.resolve(user)),
    myWallet: vi.fn(() => Promise.resolve({ wallet })),
    revokePlatformSession: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as WalletApi;
}

describe('SessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cuenta y wallet desde la API; sin sesión de cuenta queda anónimo; otros errores se propagan', async () => {
    const store = new SessionStore(api());
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.state.status));
    await store.refresh();
    expect(store.state).toMatchObject({ status: 'account', user, wallet });
    const anonymous = new SessionStore(api({ me: vi.fn(() => Promise.reject(unauthenticated())) }));
    await anonymous.refresh();
    expect(anonymous.state).toMatchObject({ status: 'anonymous', user: null, wallet: null });
    const broken = new SessionStore(api({ me: vi.fn(() => Promise.reject(new Error('red'))) }));
    await expect(broken.refresh()).rejects.toThrow('red');
    expect(seen).toContain('account');
  });

  it('vence con la PlatformSession: se bloquea y se revoca en el backend', async () => {
    const revoke = vi.fn(() => Promise.resolve());
    const store = new SessionStore(api({ revokePlatformSession: revoke }));
    store.unlocked(await unlockedFor(15));
    vi.advanceTimersByTime(14 * 60_000);
    expect(store.state.unlocked).not.toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store.state).toMatchObject({ unlocked: null, lastLock: 'EXPIRED' });
    expect(revoke).toHaveBeenCalledWith('ps1');
  });

  it('inactividad: 5 minutos sólo cuentan con una pantalla sensible montada; la interacción reinicia la cuenta', async () => {
    const store = new SessionStore(api());
    store.unlocked(await unlockedFor(60));
    vi.advanceTimersByTime(INACTIVITY_LOCK_MS + 10_000);
    expect(store.state.unlocked).not.toBeNull();
    const leave = store.enterSensitive();
    vi.advanceTimersByTime(INACTIVITY_LOCK_MS - 5_000);
    store.touch();
    vi.advanceTimersByTime(INACTIVITY_LOCK_MS - 5_000);
    expect(store.state.unlocked).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.state).toMatchObject({ unlocked: null, lastLock: 'INACTIVITY' });
    leave();
  });

  it('bloqueo manual, reemplazo del desbloqueo y logout aunque la sesión ya no exista', async () => {
    const client = api({ logout: vi.fn(() => Promise.reject(unauthenticated())) });
    const store = new SessionStore(client);
    await store.refresh();
    const first = await unlockedFor(15);
    store.unlocked(first);
    const replacement = { ...first, envelope: { replaced: true } as unknown as UnlockedWallet['envelope'] };
    store.replaceUnlocked(replacement);
    expect(store.state.unlocked).toBe(replacement);
    await store.lock('MANUAL');
    expect(store.state).toMatchObject({ unlocked: null, lastLock: 'MANUAL' });
    store.replaceUnlocked(first);
    expect(store.state.unlocked).toBeNull();
    await store.logout();
    expect(store.state).toMatchObject({ status: 'anonymous', user: null });
    const failing = new SessionStore(api({ logout: vi.fn(() => Promise.reject(new Error('caída'))) }));
    await expect(failing.logout()).rejects.toThrow('caída');
    expect(failing.state.status).toBe('anonymous');
  });
});

describe('step-up', () => {
  it('pide el código con una session key nueva y exige que la PlatformSession sea del scope pedido', async () => {
    const client = {
      stepUpStart: vi.fn(() => Promise.resolve({ challengeId: 'c1', expiresAt: 'x', keyRestoreNonce: undefined })),
      stepUpFinish: vi.fn(() =>
        Promise.resolve({
          token: 't',
          csrfToken: 'c',
          session: {
            id: 's',
            scope: 'KEY_RESTORE',
            authMethod: 'STEP_UP',
            walletId: 'w',
            safe: null,
            issuedAt: '',
            expiresAt: '',
          },
        }),
      ),
    } as unknown as WalletApi;
    const pending = await startStepUp(client, 'ONBOARDING', 'w1');
    expect(pending).toMatchObject({ scope: 'ONBOARDING', challengeId: 'c1', keyRestoreNonce: null });
    expect(pending.key.privateKey.extractable).toBe(false);
    await expect(finishStepUp(client, pending, { code: '12345678' })).rejects.toThrow('otro scope');
    const now = Date.now();
    expect(isLive({ expiresAt: new Date(now + 60_000).toISOString() } as PlatformSessionView, now)).toBe(true);
    expect(isLive({ expiresAt: new Date(now + 10_000).toISOString() } as PlatformSessionView, now)).toBe(false);
  });

  it('el vencimiento del código sale del expiresAt del backend (no de un plazo fijo de la app)', () => {
    expect(codeExpiryText('2026-10-19T15:42:00Z', 'UTC')).toBe('Vence a las 15:42.');
    expect(codeExpiryText('2026-10-19T03:07:30Z', 'America/Argentina/Buenos_Aires')).toBe('Vence a las 00:07.');
    expect(codeExpiryText('2026-10-19T15:52:00Z', 'UTC')).not.toBe(codeExpiryText('2026-10-19T15:42:00Z', 'UTC'));
  });
});
