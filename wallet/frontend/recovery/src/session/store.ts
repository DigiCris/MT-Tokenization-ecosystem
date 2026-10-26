// Estado de sesión de Recovery, sólo en memoria ([F-KEY-07]): la cuenta (cookie del listener de Recovery), la
// PlatformSession del step-up (token y session key no extraíble; 15 min, no se renueva) y R desbloqueada (sobre + K_R
// no exportable). Se bloquea —R se descarta y la PlatformSession se revoca— por inactividad en pantallas sensibles
// (5 min, [F-SES-04]), al vencer la PlatformSession, al salir o a pedido del usuario. Un minuto antes del bloqueo por
// inactividad se avisa (cuarta revisión de P17.MAN, hallazgo 2): anotar la Password R y las 17 palabras puede llevar
// más de 5 minutos sin tocar la pantalla. El aviso no pausa la cuenta; cualquier tecla o toque la reinicia.
import type { PlatformAuth } from '../api/client.ts';
import type { PlatformSessionView, RecoveryApi, User } from '../api/recovery-api.ts';
import type { UnlockedRecovery } from '../crypto/session.ts';
import type { ExternalSession } from '../external-wallet/types.ts';
import { externalSigner, internalSigner, type RecoverySigner } from '../signer/recovery-signer.ts';

export const INACTIVITY_MS = 5 * 60_000;
/** Cuánto antes del bloqueo por inactividad se avisa. */
export const INACTIVITY_WARNING_MS = 60_000;

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
  /** Falta menos de un minuto para el bloqueo por inactividad. */
  inactivityWarning: boolean;
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
    inactivityWarning: false,
  };
  readonly #listeners = new Set<Listener>();
  readonly #api: Pick<RecoveryApi, 'me' | 'logout' | 'revokePlatformSession'>;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  #warningTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.#expiryTimer = null;
    this.#stopInactivity();
    if (platform) void this.#api.revokePlatformSession(platform.auth.sessionId).catch(() => undefined);
    const { external } = this.#state;
    if (external) void external.disconnect();
    if (platform === null && this.#state.recovery === null && external === null) return;
    this.#set({ platform: null, recovery: null, external: null, lockReason: reason, inactivityWarning: false });
  }

  /**
   * Descarta R y desconecta la wallet externa sin revocar la verificación ni contar como bloqueo: una R que el pedido
   * ya no va a usar, o la de un sobre que no es de la Safe (para elegir otro).
   */
  discardKey(): void {
    const { recovery, external } = this.#state;
    if (external) void external.disconnect();
    if (recovery === null && external === null) return;
    this.#set({ recovery: null, external: null });
  }

  /** Una pantalla sensible montada: la inactividad cuenta mientras haya alguna. */
  enterSensitive(): () => void {
    this.#sensitive++;
    this.touch();
    return () => {
      this.#sensitive--;
      if (this.#sensitive === 0) this.#stopInactivity();
    };
  }

  /**
   * Interacción del usuario: reinicia la cuenta de inactividad en pantallas sensibles (y saca el aviso). El aviso sale
   * un minuto antes del bloqueo, si todavía hay algo abierto.
   */
  touch(): void {
    this.#stopInactivity();
    if (this.#sensitive === 0 || !this.#open()) return;
    this.#warningTimer = setTimeout(() => {
      this.#warningTimer = null;
      if (this.#open()) this.#set({ inactivityWarning: true });
    }, INACTIVITY_MS - INACTIVITY_WARNING_MS);
    this.#inactivityTimer = setTimeout(() => {
      this.lock('INACTIVITY');
    }, INACTIVITY_MS);
  }

  /** Hay algo que el bloqueo descartaría: la PlatformSession, R desbloqueada o la wallet externa. */
  #open(): boolean {
    const { platform, recovery, external } = this.#state;
    return platform !== null || recovery !== null || external !== null;
  }

  #stopInactivity(): void {
    if (this.#inactivityTimer !== null) clearTimeout(this.#inactivityTimer);
    if (this.#warningTimer !== null) clearTimeout(this.#warningTimer);
    this.#inactivityTimer = null;
    this.#warningTimer = null;
    if (this.#state.inactivityWarning) this.#set({ inactivityWarning: false });
  }
}
