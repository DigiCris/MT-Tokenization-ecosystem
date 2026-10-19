// `/emergency` (P19.T10): el botón de pánico si U está comprometida. Con R + S: quitar destinos de la whitelist (leídos
// on-chain), anular una operación pendiente con una NoOp del mismo nonce y revocar el permiso residual del
// SwapExecutor sobre USDC/USDT. Cada SafeTx la arma la app y se compara con la del backend antes de que R firme.
import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, getAddress, type Address } from 'viem';
import type { OperationStatus, TokenSymbol } from '../api/recovery-api.ts';
import { api, pinned, reader } from '../app/services.ts';
import { destinationWhitelistAbi } from '../chain/abis/DestinationWhitelist.ts';
import { safeNonce } from '../chain/rotations.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { OperationReview, STATE_TEXT } from '../operations/OperationReview.tsx';
import { releasePrepared, SETTLED_STATES, verifiedOrReleased } from '../operations/sign.ts';
import { useSensitiveScreen } from '../session/context.tsx';
import { RecoveryGate, type RecoveryContext } from '../session/RecoveryGate.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { cancellableOperations, noopCall, removeDestinationCall, revokeApprovalCall } from './emergency.ts';

interface State {
  destinations: { address: Address; label: string | null }[];
  operations: OperationStatus[];
  allowances: { symbol: TokenSymbol; amount: bigint }[];
}

function Emergency({ ctx }: { ctx: RecoveryContext }) {
  const { platform, signer, walletId, safe } = ctx;
  const { contracts } = pinned.system;
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [review, setReview] = useState<{ title: string; item: VerifiedOperation } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      try {
        const [onchain, labels, ops, allowances] = await Promise.all([
          reader.readContract({
            address: contracts.whitelist.address,
            abi: destinationWhitelistAbi,
            functionName: 'destinationsOf',
            args: [safe],
          }),
          api.whitelist(walletId).catch(() => ({ entries: [] })),
          api.operations(walletId, { limit: 20 }),
          Promise.all(
            (['USDC', 'USDT'] as const).map(async (symbol) => ({
              symbol,
              amount: await reader.readContract({
                address: pinned.chain.tokens[symbol].address,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [safe, contracts.swapExecutor.address],
              }),
            })),
          ),
        ]);
        if (!alive.current) return;
        setState({
          destinations: onchain.map((address) => ({
            address: getAddress(address),
            label: labels.entries.find((e) => e.destination.toLowerCase() === address.toLowerCase())?.label ?? null,
          })),
          operations: cancellableOperations(ops.items),
          allowances: allowances.filter((a) => a.amount > 0n),
        });
      } catch (caught) {
        if (alive.current) setError(describeError(caught));
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [walletId, safe, contracts.whitelist.address, contracts.swapExecutor.address, reload]);

  const removeDestination = useAsyncAction(
    useCallback(
      async (destination: Address) => {
        await releasePrepared(api, platform);
        const operation = await api.emergencyWhitelistRemove(platform.auth, walletId, destination);
        const item = await verifiedOrReleased(api, platform, [operation], async () =>
          verifyPrepared(operation, {
            safe,
            chainId: 8453,
            onchainNonce: await safeNonce(reader, safe),
            build: (n) => removeDestinationCall(contracts.whitelist.address, destination, n),
          }),
        );
        setReview({ title: 'Quitar el destino de tu whitelist', item });
      },
      [platform, walletId, safe, contracts.whitelist.address],
    ),
  );

  const noop = useAsyncAction(
    useCallback(
      async (target: OperationStatus) => {
        await releasePrepared(api, platform);
        const { noop: prepared } = await api.emergencyNoop(platform.auth, walletId, target.id);
        if (prepared === null) {
          setNote('La operación todavía no estaba firmada: quedó cancelada sin necesidad de una NoOp.');
          setReload((n) => n + 1);
          return;
        }
        const item = await verifiedOrReleased(api, platform, [prepared], async () => {
          const targetNonce = BigInt(target.safeNonce);
          return verifyPrepared(prepared, {
            safe,
            chainId: 8453,
            onchainNonce: await safeNonce(reader, safe),
            build: (n) => noopCall(safe, targetNonce, n),
          });
        });
        setReview({ title: 'Anular la operación pendiente con una NoOp', item });
      },
      [platform, walletId, safe],
    ),
  );

  const revoke = useAsyncAction(
    useCallback(
      async (symbol: TokenSymbol) => {
        await releasePrepared(api, platform);
        const operation = await api.emergencyRevokeApproval(platform.auth, walletId, symbol);
        const item = await verifiedOrReleased(api, platform, [operation], async () =>
          verifyPrepared(operation, {
            safe,
            chainId: 8453,
            onchainNonce: await safeNonce(reader, safe),
            build: (n) => revokeApprovalCall(pinned.chain.tokens[symbol].address, contracts.swapExecutor.address, n),
          }),
        );
        setReview({ title: `Revocar el permiso del SwapExecutor sobre ${symbol}`, item });
      },
      [platform, walletId, safe, contracts.swapExecutor.address],
    ),
  );

  if (review) {
    return (
      <OperationReview
        title={review.title}
        items={[review.item]}
        platform={platform}
        signer={signer}
        onCancel={() => {
          setReview(null);
        }}
        onSettled={(statuses) => {
          if (statuses.every((s) => SETTLED_STATES.includes(s.status))) {
            setReview(null);
            setReload((n) => n + 1);
          }
        }}
      />
    );
  }

  const busy = removeDestination.pending || noop.pending || revoke.pending;
  const actionError = removeDestination.error ?? noop.error ?? revoke.error;
  return (
    <div className="stack">
      <section className="card card--danger stack" aria-labelledby="emergency-title">
        <h1 id="emergency-title">Emergencia</h1>
        <p>
          Si creés que alguien tiene tu clave U, quitá destinos, anulá operaciones pendientes y revocá permisos con R.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        {note && <Notice tone="success">{note}</Notice>}
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {state === null && !error && <p className="muted">Leyendo tu Safe…</p>}
      </section>
      {state && (
        <>
          <section className="card stack" aria-labelledby="em-whitelist-title">
            <h2 id="em-whitelist-title">Destinos de la whitelist</h2>
            {state.destinations.length === 0 && <p className="muted">No hay destinos.</p>}
            <ul className="list">
              {state.destinations.map((d) => (
                <li key={d.address} className="list__item" data-destination={d.address}>
                  <strong>{d.label ?? 'Sin nombre'}</strong> <AddressText address={d.address} />{' '}
                  <button
                    type="button"
                    className="button button--link"
                    disabled={busy}
                    onClick={() => void removeDestination.run(d.address)}
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="card stack" aria-labelledby="em-ops-title">
            <h2 id="em-ops-title">Operaciones pendientes</h2>
            {state.operations.length === 0 && <p className="muted">No hay operaciones pendientes.</p>}
            <ul className="list">
              {state.operations.map((op) => (
                <li key={op.id} className="list__item" data-operation={op.id} data-status={op.status}>
                  {op.operationType} · nonce {op.safeNonce} · {STATE_TEXT[op.status]}{' '}
                  <button
                    type="button"
                    className="button button--link"
                    disabled={busy}
                    onClick={() => void noop.run(op)}
                  >
                    Anular
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="card stack" aria-labelledby="em-allowance-title">
            <h2 id="em-allowance-title">Permisos del SwapExecutor</h2>
            {state.allowances.length === 0 && <p className="muted">No hay permisos activos.</p>}
            <ul className="list">
              {state.allowances.map((a) => (
                <li key={a.symbol} className="list__item" data-allowance={a.symbol}>
                  {a.symbol}: {a.amount.toString()} unidades{' '}
                  <button
                    type="button"
                    className="button button--link"
                    disabled={busy}
                    onClick={() => void revoke.run(a.symbol)}
                  >
                    Revocar
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export function EmergencyPage() {
  useSensitiveScreen();
  return <RecoveryGate>{(ctx) => <Emergency ctx={ctx} />}</RecoveryGate>;
}
