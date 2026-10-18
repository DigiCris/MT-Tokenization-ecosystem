// Entrada de la app Wallet: el arranque de seguridad (reporter, CSP/Trusted Types, política mtw-default y kill-switch
// de service workers) corre antes de renderizar; si la CSP no se aplica, sólo se muestra la pantalla de bloqueo.
import './styles/design-tokens/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { createAppRouter } from './app/router.tsx';
import { SecurityBlocked } from './app/SecurityBlocked.tsx';
import { SecurityStatus } from './app/security-status.ts';
import { appConfig } from './config/index.ts';
import { bootSecurity } from './security/boot.ts';
import { WORKER_ALLOWLIST } from './workers/registry.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('falta el contenedor #root');

const boot = await bootSecurity({
  apiBaseUrl: appConfig.apiBaseUrl,
  releaseId: appConfig.releaseId,
  workerAllowlist: WORKER_ALLOWLIST,
});

createRoot(container).render(
  <StrictMode>
    {boot.failure === null ? (
      <SecurityStatus value={boot}>
        <RouterProvider router={createAppRouter()} />
      </SecurityStatus>
    ) : (
      <SecurityBlocked failure={boot.failure} />
    )}
  </StrictMode>,
);
