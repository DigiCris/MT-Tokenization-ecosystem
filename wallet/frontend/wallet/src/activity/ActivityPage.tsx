// `/activity` (P18.T08): operaciones con sus estados y transfers entrantes/salientes indexados, por fecha, con el hash
// de la transacción y el link al explorer; paginada por cursor. Los destinos aparecen con su nombre de la whitelist y
// todos los estados que se pueden ver tienen una ayuda breve.
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { OperationStatus, Transfer } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { STATE_HELP, STATE_TEXT } from '../operations/describe.ts';
import { addressNames, backendLabels, shownLabels } from '../operations/names.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { mergeActivity } from './activity.ts';
import { ActivityList } from './ActivityList.tsx';

/** Labels para nombrar contrapartes; sin ellos la actividad muestra sólo las direcciones completas. */
async function whitelistLabels(walletId: string): Promise<Map<string, string>> {
  return api
    .whitelist(walletId)
    .then(backendLabels)
    .catch(() => new Map<string, string>());
}

/** Qué significa cada estado que puede mostrar una operación, en el orden en que los recorre. */
export function StateHelp() {
  return (
    <details className="help" data-state-help>
      <summary>¿Qué significa cada estado?</summary>
      <dl className="summary">
        {STATE_HELP.map((help) => (
          <Fragment key={help.state}>
            <dt>{STATE_TEXT[help.state]}</dt>
            <dd>{help.text}</dd>
          </Fragment>
        ))}
        <dt>Cancelada antes de firmar</dt>
        <dd>se canceló sin tu firma (la cancelaste vos en el review o la plataforma descartó lo preparado).</dd>
      </dl>
      <p>
        La hora es la de la inclusión en un bloque de Base; las operaciones que no llegaron a la red muestran cuándo se
        prepararon.
      </p>
    </details>
  );
}

function Activity({ ctx }: { ctx: OperatingWallet }) {
  const walletId = ctx.wallet.id;
  const [operations, setOperations] = useState<OperationStatus[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [cursors, setCursors] = useState<{ operations: string | null; transfers: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      api.operations(walletId, { limit: 20 }),
      api.transfers(walletId, { limit: 20 }),
      whitelistLabels(walletId),
    ])
      .then(([ops, trs, names]) => {
        if (!live) return;
        setOperations(ops.items);
        setTransfers(trs.items);
        setLabels(names);
        setCursors({ operations: ops.nextCursor, transfers: trs.nextCursor });
      })
      .catch((caught: unknown) => {
        if (live) setError(describeError(caught));
      });
    return () => {
      live = false;
    };
  }, [walletId]);

  const more = useAsyncAction(
    useCallback(async () => {
      if (cursors === null) return;
      const [ops, trs] = await Promise.all([
        cursors.operations === null ? null : api.operations(walletId, { limit: 20, before: cursors.operations }),
        cursors.transfers === null ? null : api.transfers(walletId, { limit: 20, before: cursors.transfers }),
      ]);
      setOperations((current) => [...current, ...(ops?.items ?? [])]);
      setTransfers((current) => [...current, ...(trs?.items ?? [])]);
      setCursors({ operations: ops?.nextCursor ?? null, transfers: trs?.nextCursor ?? null });
    }, [walletId, cursors]),
  );
  const hasMore = cursors !== null && (cursors.operations !== null || cursors.transfers !== null);
  const nameOf = addressNames(
    { safe: ctx.wallet.safe, chain: pinnedChain, system: systemContracts },
    shownLabels(labels),
  );
  return (
    <section className="card stack" aria-labelledby="activity-title">
      <h1 id="activity-title">Actividad</h1>
      {(error ?? more.error) && <Notice tone="error">{error ?? more.error}</Notice>}
      {cursors === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <ActivityList items={mergeActivity(operations, transfers)} nameOf={nameOf} />
      )}
      <StateHelp />
      {hasMore && (
        <button
          type="button"
          className="button button--secondary"
          disabled={more.pending}
          aria-busy={more.pending}
          onClick={() => void more.run()}
        >
          Ver más
        </button>
      )}
    </section>
  );
}

export function ActivityPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Activity ctx={ctx} />}</SafeGate>;
}
