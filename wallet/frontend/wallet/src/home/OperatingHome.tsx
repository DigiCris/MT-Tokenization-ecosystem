// Inicio con la wallet operativa (P18.T03): dirección de la Safe (EIP-55, copiar, QR de recepción con la advertencia de
// red), saldos leídos de la cadena y cruzados con el backend, alertas leídas on-chain (rotaciones pendientes y destinos
// de la whitelist que todavía se están activando: la alerta in-app de ADR-006/ESC-16 —si no lo agregaste vos o no es
// la dirección que esperabas—, con acceso directo a la baja), el pedido de rotación de S de la plataforma, los avisos
// in-app del backend (P15.T07) y la actividad reciente.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Rotation } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { mergeActivity, type ActivityItem } from '../activity/activity.ts';
import { ActivityList } from '../activity/ActivityList.tsx';
import { formatAmount } from '../assets/amount.ts';
import { readAssets, type AssetView } from '../assets/assets.ts';
import { useChainNow } from '../chain/ChainNow.tsx';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { NotificationsPanel } from '../notifications/NotificationsPanel.tsx';
import { ROLE_TEXT } from '../operations/describe.ts';
import { addressNames, backendLabels, shownLabels, userLabel } from '../operations/names.ts';
import type { OperatingWallet } from '../safe/SafeGate.tsx';
import { readPendingProposals, type PendingProposal } from '../security/rotations/rotations.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { activating, activationText, readWhitelist, type Destination } from '../whitelist/whitelist.ts';
import type { RemoveIntent } from '../whitelist/WhitelistPage.tsx';

export function OperatingHome({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingProposal[]>([]);
  const [request, setRequest] = useState<Rotation | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [whitelistError, setWhitelistError] = useState(false);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  // La activación de un destino la decide el contrato con block.timestamp: la cuenta regresiva usa la hora de la cadena.
  const chainNow = useChainNow(reader);

  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      const backend = await api.balances(wallet.id).catch(() => null);
      try {
        const read = await readAssets(reader, pinnedChain, wallet.safe, backend);
        if (alive.current) setAssets(read);
      } catch (error) {
        if (alive.current) setAssetsError(describeError(error));
      }
    })();
    void readPendingProposals(reader, systemContracts.contracts.timelock.address, wallet.safe)
      .then((found) => {
        if (alive.current) setPending(found);
      })
      .catch(() => undefined);
    void api
      .listRotations(wallet.id)
      .then(({ items }) => {
        if (alive.current)
          setRequest(items.find((r) => r.role === 'S' && r.status === 'DRAFT' && r.requestReason !== null) ?? null);
      })
      .catch(() => undefined);
    // La whitelist sale de la cadena; del backend, sólo los nombres (también para la actividad).
    void (async () => {
      const backend = await api.whitelist(wallet.id).catch(() => ({ entries: [] }));
      if (alive.current) setLabels(backendLabels(backend));
      try {
        const list = await readWhitelist(reader, systemContracts.contracts.whitelist.address, wallet.safe, backend);
        if (alive.current) setDestinations(list);
      } catch {
        if (alive.current) setWhitelistError(true);
      }
    })();
    void Promise.all([api.operations(wallet.id, { limit: 10 }), api.transfers(wallet.id, { limit: 10 })])
      .then(([operations, transfers]) => {
        if (alive.current) setActivity(mergeActivity(operations.items, transfers.items).slice(0, 5));
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [wallet.id, wallet.safe, reader]);

  const nameOf = addressNames({ safe: wallet.safe, chain: pinnedChain, system: systemContracts }, shownLabels(labels));

  return (
    <div className="stack">
      {activating(destinations ?? []).map((d) => (
        <Notice key={d.address} tone="warning">
          <span data-activating={d.address}>
            Un destino nuevo ({d.label === null ? 'sin nombre' : userLabel(d.label)} <AddressText address={d.address} />
            ) {activationText(d.activatesAt, chainNow)}: si no lo agregaste vos o si no es la dirección que esperabas,
            quitalo antes de que se active.{' '}
            <Link to="/whitelist" state={{ remove: d.address } satisfies RemoveIntent}>
              Quitarlo
            </Link>
          </span>
        </Notice>
      ))}
      {whitelistError && (
        <Notice tone="warning">
          No se pudo leer tu whitelist en Base para revisar si hay destinos nuevos:{' '}
          <Link to="/whitelist">revisala</Link>.
        </Notice>
      )}
      {request && (
        <Notice tone="warning">
          La plataforma pidió rotar su clave (S). <Link to="/security/rotations">Revisar y firmar la propuesta</Link>
        </Notice>
      )}
      {pending.map((p) => (
        <Notice key={p.id} tone="warning">
          Hay una rotación pendiente de {ROLE_TEXT[p.role] ?? p.role}: se puede ejecutar desde el{' '}
          {p.executableAt.toLocaleString('es-AR')}. <Link to="/security/rotations">Ver rotaciones</Link>
        </Notice>
      ))}
      <NotificationsPanel nameOf={nameOf} />
      <section className="card stack" aria-labelledby="safe-title">
        <h1 id="safe-title">Tu Safe</h1>
        <p>
          <AddressText address={wallet.safe} copy />
        </p>
        <p role="status" className="muted">
          Wallet desbloqueada (dirección de tu clave U: <AddressText address={unlocked.envelope.keyAddress} />
          ).
        </p>
        <QrCanvas text={wallet.safe} label="QR de la dirección de tu Safe para recibir" size={200} />
        <Notice tone="warning">
          Enviá a esta dirección sólo USDC o USDT en la red Base. Otras redes u otros tokens no se pueden recuperar
          desde esta app.
        </Notice>
      </section>
      <section className="card stack" aria-labelledby="balances-title">
        <h2 id="balances-title">Saldos</h2>
        {assetsError && <Notice tone="error">{assetsError}</Notice>}
        {!assets && !assetsError && <p className="muted">Leyendo saldos en Base…</p>}
        {assets && (
          <ul className="balances">
            {assets.map((a) => (
              <li key={a.symbol} data-token={a.symbol} data-balance={a.balance.toString()}>
                <strong>{formatAmount(a.balance, a.decimals)}</strong> {a.symbol}
                {a.backendMismatch && (
                  <span className="muted">
                    {' '}
                    (la plataforma informa {formatAmount(a.backendBalance ?? 0n, a.decimals)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <nav className="actions" aria-label="Operar">
          <Link className="button" to="/send">
            Enviar
          </Link>
          <Link className="button button--secondary" to="/swap">
            Swap
          </Link>
          <Link className="button button--secondary" to="/whitelist">
            Whitelist
          </Link>
          <Link className="button button--ghost" to="/assets">
            Activos
          </Link>
        </nav>
      </section>
      <section className="card stack" aria-labelledby="recent-title">
        <h2 id="recent-title">Actividad reciente</h2>
        {activity === null ? <p className="muted">Cargando…</p> : <ActivityList items={activity} nameOf={nameOf} />}
        <p>
          <Link to="/activity">Ver toda la actividad</Link> ·{' '}
          <Link to="/sovereign" reloadDocument>
            Co-firmar una operación soberana
          </Link>
        </p>
      </section>
    </div>
  );
}
