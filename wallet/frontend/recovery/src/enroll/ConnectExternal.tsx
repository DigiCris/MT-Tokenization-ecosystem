// R externa (P19.T03, [F-KEY-09], [F-CON-01]): el chunk lazy de wallet externa (wagmi y los conectores sólo se cargan
// acá) lista las wallets del navegador (EIP-6963), MetaMask, Coinbase Wallet (sólo EOA) y WalletConnect con QR propio;
// la cuenta conectada tiene que ser una EOA en Base (lo verifica la firma de la prueba de control).
import { useCallback, useEffect, useState } from 'react';
import { appConfig } from '../config/index.ts';
import type { ConnectorChoice, ExternalSession } from '../external-wallet/types.ts';
import { loadExternalWallet } from '../external-wallet/load.ts';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';

function options() {
  return {
    rpcUrl: appConfig.rpcUrl,
    walletConnectProjectId: appConfig.walletConnectProjectId,
    appUrl: window.location.origin,
  };
}

export function ConnectExternal({ onConnected }: { onConnected: (session: ExternalSession) => void }) {
  const [connectors, setConnectors] = useState<ConnectorChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pairingUri, setPairingUri] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadExternalWallet()
      .then((module) => module.listConnectors(options()))
      .then((found) => {
        if (alive) setConnectors(found);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const connect = useAsyncAction(
    useCallback(
      async (connectorId: string) => {
        setPairingUri(null);
        const module = await loadExternalWallet();
        const session = await module.connectExternal(options(), connectorId, setPairingUri);
        setPairingUri(null);
        onConnected(session);
      },
      [onConnected],
    ),
  );

  return (
    <section className="card stack" aria-labelledby="external-title">
      <h2 id="external-title">Usar una wallet externa como clave R</h2>
      <p>
        La wallet tiene que ser una cuenta común (EOA) en Base. Va a firmar la prueba de que controlás esa clave y, más
        adelante, las operaciones de recuperación.
      </p>
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {connectors === null && !loadError && <p className="muted">Buscando wallets…</p>}
      <div className="actions">
        {connectors?.map((c) => (
          <button
            key={c.id}
            type="button"
            className="button button--secondary"
            disabled={connect.pending}
            data-connector={c.id}
            onClick={() => void connect.run(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      {pairingUri && (
        <div className="stack">
          <p>Escaneá este QR con tu wallet (WalletConnect):</p>
          <QrCanvas text={pairingUri} label="QR de WalletConnect para conectar tu wallet" />
        </div>
      )}
      {connect.error && <Notice tone="error">{connect.error}</Notice>}
    </section>
  );
}
