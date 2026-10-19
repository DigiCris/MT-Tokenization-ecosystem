// Conectar el Drive de Recovery ([F-DRV-01]): la ida a Google es una redirección de página completa, así que se ofrece
// antes de tener algo en memoria (antes del step-up del enrollment o al empezar una restauración). A la vuelta, el
// token queda sólo en memoria y la app vuelve a `returnTo`.
import { useState } from 'react';
import { appConfig } from '../config/index.ts';
import { describeError } from '../ui/errors.ts';
import { Notice } from '../ui/forms.tsx';
import { startDriveConnect, takeDriveConnectError } from './oauth.ts';
import { hasDriveToken } from './token.ts';

export function driveConfig() {
  return appConfig.googleClientId === null
    ? null
    : { clientId: appConfig.googleClientId, redirectUri: appConfig.googleRedirectUri };
}

export function DriveConnect({ returnTo, children }: { returnTo: string; children: string }) {
  const [callbackError] = useState(() => takeDriveConnectError()?.message ?? null);
  const [error, setError] = useState<string | null>(null);
  const config = driveConfig();
  if (config === null) return null;
  if (hasDriveToken()) return <Notice tone="success">Google Drive conectado (carpeta privada de Recovery).</Notice>;
  return (
    <div className="stack" data-drive-connect>
      <p className="muted">{children}</p>
      <button
        type="button"
        className="button button--secondary"
        onClick={() => {
          try {
            startDriveConnect(config, returnTo);
          } catch (caught) {
            setError(describeError(caught));
          }
        }}
      >
        Conectar Google Drive
      </button>
      {(error ?? callbackError) && <Notice tone="error">{error ?? callbackError}</Notice>}
    </div>
  );
}
