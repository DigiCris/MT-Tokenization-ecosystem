// Estado de sesión de la pestaña ([F-SES], [F-KEY-05]): cuenta (cookies del API host; el CSRF vive en el cliente),
// wallet viva y desbloqueo (sobre, K_U no exportable y PlatformSession con su session key, sólo en memoria). Se bloquea
// solo al vencer la PlatformSession o tras 5 minutos sin interacción en pantallas sensibles ([F-SES-04]), con un aviso un
// minuto antes; al bloquear se revoca la PlatformSession en el backend y se descartan todas las referencias.
import type { User, WalletApi, WalletView } from '../api/wallet-api.ts';
import { ApiError } from '../api/problem.ts';
import { revokeDriveToken } from '../drive/token.ts';
import type { UnlockedWallet } from '../unlock/unlock.ts';

export const INACTIVITY_LOCK_MS = 5 * 60_000;
/** El aviso sale un minuto antes del bloqueo por inactividad (cualquier interacción lo saca y reinicia la cuenta). */
export const INACTIVITY_WARNING_MS = 60_000;

export type LockReason = 'MANUAL' | 'INACTIVITY' | 'EXPIRED' | 'LOGOUT';

export interface SessionSnapshot {
  status: 'loading' | 'anonymous' | 'account';
  user: User | null;
  wallet: WalletView | null;
  unlocked: UnlockedWallet | null;
  lastLock: LockReason | null;
  /** Falta menos de un minuto para el bloqueo por inactividad. */
  inactivityWarning: boolean;
}

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => {
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};

export class SessionStore {
  readonly #api: WalletApi;
  readonly #timers: Timers;
  #state: SessionSnapshot = {
    status: 'loading',
    user: null,
    wallet: null,
    unlocked: null,
    lastLock: null,
    inactivityWarning: false,
  };
  readonly #listeners = new Set<() => void>();
  #expiry: unknown = null;
  #idle: unknown = null;
  #sensitive = 0;
  #lastActivity = 0;

  constructor(api: WalletApi, timers: Timers = systemTimers) {
    this.#api = api;
    this.#timers = timers;
  }

  get state(): SessionSnapshot {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<SessionSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Cuenta y wallet desde la API; sin sesión de cuenta (401) queda anónimo. */
  async refresh(): Promise<void> {
    try {
      const user = await this.#api.me();
      const { wallet } = await this.#api.myWallet();
      this.#set({ status: 'account', user, wallet });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.#dropUnlocked();
        this.#set({ status: 'anonymous', user: null, wallet: null, unlocked: null });
        return;
      }
      throw error;
    }
  }

  async refreshWallet(): Promise<WalletView | null> {
    const { wallet } = await this.#api.myWallet();
    this.#set({ wallet });
    return wallet;
  }

  signedIn(user: User): void {
    this.#set({ status: 'account', user, lastLock: null });
  }

  setUser(user: User): void {
    this.#set({ user });
  }

  async logout(): Promise<void> {
    await this.lock('LOGOUT');
    try {
      await this.#api.logout();
    } catch (error) {
      // La sesión ya no existía (revocada desde otra pantalla o vencida): el resultado es el mismo.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    } finally {
      await revokeDriveToken();
      this.#set({ status: 'anonymous', user: null, wallet: null, unlocked: null });
    }
  }

  unlocked(unlocked: UnlockedWallet): void {
    this.#dropUnlocked();
    this.#lastActivity = this.#timers.now();
    const remaining = Date.parse(unlocked.session.expiresAt) - this.#timers.now();
    this.#expiry = this.#timers.setTimeout(() => void this.lock('EXPIRED'), Math.max(0, remaining));
    this.#armIdle();
    this.#set({ unlocked, lastLock: null });
  }

  /** Reemplaza el desbloqueo vigente (p. ej. tras cambiar la Password U: sobre y K nuevos, misma PlatformSession). */
  replaceUnlocked(unlocked: UnlockedWallet): void {
    if (this.#state.unlocked === null) return;
    this.#set({ unlocked });
  }

  async lock(reason: LockReason = 'MANUAL'): Promise<void> {
    const current = this.#state.unlocked;
    this.#dropUnlocked();
    if (current === null) return;
    this.#set({ unlocked: null, lastLock: reason, inactivityWarning: false });
    try {
      await this.#api.revokePlatformSession(current.session.id);
    } catch {
      // Vencida o sin red: la PlatformSession vence sola (≤ 15 min) y la session key ya no existe en memoria.
    }
  }

  /** Una pantalla sensible montada: la inactividad cuenta mientras haya alguna. */
  enterSensitive(): () => void {
    this.#sensitive++;
    this.touch();
    return () => {
      this.#sensitive--;
    };
  }

  touch(): void {
    this.#lastActivity = this.#timers.now();
    if (this.#state.inactivityWarning) this.#set({ inactivityWarning: false });
  }

  #armIdle(): void {
    if (this.#idle !== null) this.#timers.clearTimeout(this.#idle);
    this.#idle = this.#timers.setTimeout(() => {
      this.#idle = null;
      if (this.#state.unlocked === null) return;
      const idleFor = this.#timers.now() - this.#lastActivity;
      if (this.#sensitive > 0 && idleFor >= INACTIVITY_LOCK_MS) {
        void this.lock('INACTIVITY');
        return;
      }
      const warning = this.#sensitive > 0 && idleFor >= INACTIVITY_LOCK_MS - INACTIVITY_WARNING_MS;
      if (warning !== this.#state.inactivityWarning) this.#set({ inactivityWarning: warning });
      this.#armIdle();
    }, 1_000);
  }

  #dropUnlocked(): void {
    if (this.#expiry !== null) this.#timers.clearTimeout(this.#expiry);
    if (this.#idle !== null) this.#timers.clearTimeout(this.#idle);
    this.#expiry = null;
    this.#idle = null;
  }
}
