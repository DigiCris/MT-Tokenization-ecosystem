// Entrada de la app Recovery: el arranque de seguridad (reporter, CSP/Trusted Types, política mtw-default y kill-switch
// de service workers) corre antes de renderizar; si la CSP no se aplica, sólo se muestra la pantalla de bloqueo. La
// vuelta de Google (OAuth del Drive de Recovery) se procesa antes del primer render: el token queda en memoria y la URL
// limpia; fuera de esa vuelta, el estado de un viaje abandonado se descarta.
import './styles/design-tokens/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { createAppRouter } from './app/router.tsx';
import { SecurityBlocked } from './app/SecurityBlocked.tsx';
import { SecurityStatus } from './app/security-status.ts';
import { appConfig } from './config/index.ts';
import { discardAbandonedOAuthOnRestore, handleOAuthCallback } from './drive/oauth.ts';
import { bootSecurity } from './security/boot.ts';
import { SessionProvider } from './session/context.tsx';
import { WORKER_ALLOWLIST } from './workers/registry.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('falta el contenedor #root');

const boot = await bootSecurity({
  apiBaseUrl: appConfig.apiBaseUrl,
  releaseId: appConfig.releaseId,
  workerAllowlist: WORKER_ALLOWLIST,
});

if (boot.failure === null) handleOAuthCallback();
// Un viaje de OAuth abandonado (la página vuelve del bfcache) no deja su estado en la pestaña (ADR-033).
discardAbandonedOAuthOnRestore();

createRoot(container).render(
  <StrictMode>
    {boot.failure === null ? (
      <SecurityStatus value={boot}>
        <SessionProvider>
          <RouterProvider router={createAppRouter()} />
        </SessionProvider>
      </SecurityStatus>
    ) : (
      <SecurityBlocked failure={boot.failure} />
    )}
  </StrictMode>,
);
