// Entrada de la app Wallet: el arranque de seguridad (reporter, CSP/Trusted Types, política mtw-default y kill-switch
// de service workers) corre antes de renderizar; si la CSP no se aplica, sólo se muestra la pantalla de bloqueo. La
// vuelta de OAuth de Drive se procesa también antes de renderizar: el token sale de la URL y queda sólo en memoria.
import './styles/design-tokens/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { createAppRouter } from './app/router.tsx';
import { SecurityBlocked } from './app/SecurityBlocked.tsx';
import { SecurityStatus } from './app/security-status.ts';
import { abortReports, api } from './app/services.ts';
import { appConfig } from './config/index.ts';
import { handleOAuthCallback } from './drive/oauth.ts';
import { bootSecurity } from './security/boot.ts';
import { SessionProvider } from './session/context.tsx';
import { SessionStore } from './session/store.ts';
import { WORKER_ALLOWLIST } from './workers/registry.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('falta el contenedor #root');

const boot = await bootSecurity({
  apiBaseUrl: appConfig.apiBaseUrl,
  releaseId: appConfig.releaseId,
  workerAllowlist: WORKER_ALLOWLIST,
});

if (boot.failure === null) handleOAuthCallback();
const session = new SessionStore(api);
if (boot.failure === null) {
  session.refresh().catch(() => {
    // Sin API (red caída): las pantallas públicas siguen; las de cuenta reintentan al usarse.
  });
}
// Cada desbloqueo nuevo (PlatformSession OPERATIONS) lleva los avisos pendientes de reemplazos de R abortados (ADR-033).
let unlockedSession: string | null = null;
session.subscribe(() => {
  const unlocked = session.state.unlocked;
  if (unlocked === null || unlocked.session.id === unlockedSession) return;
  unlockedSession = unlocked.session.id;
  void abortReports.flush({
    platform: unlocked.platform,
    purpose: 'REPLACEMENT',
    expiresAt: unlocked.session.expiresAt,
  });
});

createRoot(container).render(
  <StrictMode>
    {boot.failure === null ? (
      <SecurityStatus value={boot}>
        <SessionProvider store={session}>
          <RouterProvider router={createAppRouter()} />
        </SessionProvider>
      </SecurityStatus>
    ) : (
      <SecurityBlocked failure={boot.failure} />
    )}
  </StrictMode>,
);
