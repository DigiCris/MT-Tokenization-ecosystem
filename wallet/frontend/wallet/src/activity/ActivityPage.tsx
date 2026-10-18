// `/activity` (P18.T08): operaciones con sus estados y transfers entrantes/salientes indexados, por fecha, con link al
// explorer; paginada por cursor.
import { useCallback, useEffect, useState } from 'react';
import type { OperationStatus, Transfer } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { mergeActivity } from './activity.ts';
import { ActivityList } from './ActivityList.tsx';

function Activity({ ctx }: { ctx: OperatingWallet }) {
  const walletId = ctx.wallet.id;
  const [operations, setOperations] = useState<OperationStatus[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [cursors, setCursors] = useState<{ operations: string | null; transfers: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([api.operations(walletId, { limit: 20 }), api.transfers(walletId, { limit: 20 })])
      .then(([ops, trs]) => {
        if (!live) return;
        setOperations(ops.items);
        setTransfers(trs.items);
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
  return (
    <section className="card stack" aria-labelledby="activity-title">
      <h1 id="activity-title">Actividad</h1>
      {(error ?? more.error) && <Notice tone="error">{error ?? more.error}</Notice>}
      {cursors === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <ActivityList items={mergeActivity(operations, transfers)} />
      )}
      {hasMore && (
        <button
          type="button"
          className="button button--secondary"
          disabled={more.pending}
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
