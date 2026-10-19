// Estado de sesión de Recovery, sólo en memoria ([F-KEY-07]): la cuenta (cookie del listener de Recovery), la
// PlatformSession del step-up (token y session key no extraíble; 15 min, no se renueva) y R desbloqueada (sobre + K_R
// no exportable). Se bloquea —R se descarta y la PlatformSession se revoca— por inactividad en pantallas sensibles
// (5 min, [F-SES-04]), al vencer la PlatformSession, al salir o a pedido del usuario.
import type { PlatformAuth } from '../api/client.ts';
import type { PlatformSessionView, RecoveryApi, User } from '../api/recovery-api.ts';
import type { UnlockedRecovery } from '../crypto/session.ts';
import type { ExternalSession } from '../external-wallet/types.ts';
import { externalSigner, internalSigner, type RecoverySigner } from '../signer/recovery-signer.ts';

export const INACTIVITY_MS = 5 * 60_000;

export interface PlatformSession {
  auth: PlatformAuth;
  view: PlatformSessionView;
}

export type LockReason = 'MANUAL' | 'INACTIVITY' | 'EXPIRED' | 'LOGOUT';

export interface SessionState {
  status: 'loading' | 'anonymous' | 'account';
  user: User | null;
  platform: PlatformSession | null;
  recovery: UnlockedRecovery | null;
  /** R externa conectada (wallet del usuario). */
  external: ExternalSession | null;
  lockReason: LockReason | null;
}

/** El firmante R disponible: la R interna desbloqueada o la wallet externa conectada. */
export function currentSigner(state: Pick<SessionState, 'recovery' | 'external'>): RecoverySigner | null {
  if (state.recovery) return internalSigner(state.recovery);
  if (state.external) return externalSigner(state.external);
  return null;
}

type Listener = () => void;

export class SessionStore {
  #state: SessionState = {
    status: 'loading',
    user: null,
    platform: null,
    recovery: null,
    external: null,
    lockReason: null,
  };
  readonly #listeners = new Set<Listener>();
  readonly #api: Pick<RecoveryApi, 'me' | 'logout' | 'revokePlatformSession'>;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #sensitive = 0;

  constructor(api: Pick<RecoveryApi, 'me' | 'logout' | 'revokePlatformSession'>) {
    this.#api = api;
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): SessionState => this.#state;

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Lee la cuenta de la cookie (al arrancar o después de un 401). */
  async refresh(): Promise<void> {
    try {
      const user = await this.#api.me();
      this.#set({ status: 'account', user });
    } catch {
      this.#set({ status: 'anonymous', user: null, platform: null, recovery: null, external: null });
    }
  }

  signedIn(user: User): void {
    this.#set({ status: 'account', user, lockReason: null });
  }

  async logout(): Promise<void> {
    this.lock('LOGOUT');
    await this.#api.logout().catch(() => undefined);
    this.#set({ status: 'anonymous', user: null });
  }

  /** PlatformSession nueva (reemplaza la anterior, que el backend ya revocó al emitir esta). */
  setPlatform(session: PlatformSession): void {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    const remaining = Date.parse(session.view.expiresAt) - Date.now();
    this.#expiryTimer = setTimeout(
      () => {
        this.lock('EXPIRED');
      },
      Math.max(0, remaining),
    );
    this.#set({ platform: session, lockReason: null });
    this.touch();
  }

  unlockRecovery(recovery: UnlockedRecovery): void {
    this.#set({ recovery, lockReason: null });
    this.touch();
  }

  connectExternal(external: ExternalSession): void {
    this.#set({ external, lockReason: null });
    this.touch();
  }

  /** Descarta R y la PlatformSession (la revoca en el backend, sin esperar). */
  lock(reason: LockReason): void {
    const { platform } = this.#state;
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    if (this.#inactivityTimer !== null) clearTimeout(this.#inactivityTimer);
    this.#expiryTimer = null;
    this.#inactivityTimer = null;
    if (platform) void this.#api.revokePlatformSession(platform.auth.sessionId).catch(() => undefined);
    const { external } = this.#state;
    if (external) void external.disconnect();
    if (platform === null && this.#state.recovery === null && external === null) return;
    this.#set({ platform: null, recovery: null, external: null, lockReason: reason });
  }

  /** Una pantalla sensible montada: la inactividad cuenta mientras haya alguna. */
  enterSensitive(): () => void {
    this.#sensitive++;
    this.touch();
    return () => {
      this.#sensitive--;
      if (this.#sensitive === 0 && this.#inactivityTimer !== null) {
        clearTimeout(this.#inactivityTimer);
        this.#inactivityTimer = null;
      }
    };
  }

  /** Interacción del usuario: reinicia la cuenta de inactividad en pantallas sensibles. */
  touch(): void {
    if (this.#inactivityTimer !== null) clearTimeout(this.#inactivityTimer);
    this.#inactivityTimer = null;
    const { platform, recovery, external } = this.#state;
    if (this.#sensitive === 0 || (platform === null && recovery === null && external === null)) return;
    this.#inactivityTimer = setTimeout(() => {
      this.lock('INACTIVITY');
    }, INACTIVITY_MS);
  }
}
