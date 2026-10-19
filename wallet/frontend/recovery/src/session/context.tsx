// Contexto React de la sesión de Recovery: el store (session/store.ts) se crea una vez por pestaña con el API real; las
// pantallas sensibles (las que tienen R o una PlatformSession a mano) se marcan con useSensitiveScreen para que cuente
// la inactividad, y cualquier tecla o toque la reinicia.
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../app/services.ts';
import { revokeDriveToken } from '../drive/token.ts';
import { SessionStore, type SessionState } from './store.ts';

const store = new SessionStore(api);
const SessionContext = createContext<SessionStore>(store);

export function SessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void store.refresh();
    const touch = () => {
      store.touch();
    };
    for (const event of ['pointerdown', 'keydown'] as const) window.addEventListener(event, touch, { passive: true });
    // Al bloquear o cerrar sesión, el token de Drive (si hay) también se descarta y se revoca en Google.
    let lockReason = store.snapshot().lockReason;
    const unsubscribe = store.subscribe(() => {
      const next = store.snapshot().lockReason;
      if (next !== null && next !== lockReason) void revokeDriveToken();
      lockReason = next;
    });
    return () => {
      unsubscribe();
      for (const event of ['pointerdown', 'keydown'] as const) window.removeEventListener(event, touch);
    };
  }, []);
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSessionStore(): SessionStore {
  return useContext(SessionContext);
}

export function useSession(): SessionState {
  const current = useSessionStore();
  return useSyncExternalStore(current.subscribe, current.snapshot);
}

/** Marca la pantalla como sensible mientras está montada (cuenta la inactividad de 5 min). */
export function useSensitiveScreen(): void {
  const current = useSessionStore();
  useEffect(() => current.enterSensitive(), [current]);
}
