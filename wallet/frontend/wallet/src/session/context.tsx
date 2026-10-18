// Contexto React del estado de sesión y la marca de "pantalla sensible" (cuenta la inactividad para el bloqueo).
import { createContext, use, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionSnapshot, SessionStore } from './store.ts';

const SessionContext = createContext<SessionStore | null>(null);

export function SessionProvider({ store, children }: { store: SessionStore; children: ReactNode }) {
  return <SessionContext value={store}>{children}</SessionContext>;
}

export function useSessionStore(): SessionStore {
  const store = use(SessionContext);
  if (store === null) throw new Error('falta SessionProvider');
  return store;
}

export function useSession(): SessionSnapshot {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, () => store.state);
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Mientras está montada, la pantalla es sensible: 5 minutos sin interacción bloquean la wallet ([F-SES-04]). */
export function useSensitiveScreen(): void {
  const store = useSessionStore();
  useEffect(() => {
    const leave = store.enterSensitive();
    const touch = () => {
      store.touch();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, touch, { passive: true });
    return () => {
      leave();
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch);
    };
  }, [store]);
}
