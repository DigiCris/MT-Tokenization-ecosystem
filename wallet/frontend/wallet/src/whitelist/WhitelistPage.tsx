// `/whitelist` (P18.T05): destinos leídos de la cadena (con los labels del backend), cuenta regresiva de activación,
// alta (código por email, revisión de la dirección completa, firma de U de la SafeTx armada por la app) y baja.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { WhitelistRequest } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { systemContracts } from '../config/index.ts';
import { useChainNow } from '../chain/ChainNow.tsx';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../operations/prepared.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import {
  addDestinationCall,
  parseDestination,
  readWhitelist,
  removeDestinationCall,
  type Destination,
} from './whitelist.ts';

function remaining(until: Date, now: number | null): string {
  if (now === null) return `se activa el ${until.toLocaleString('es-AR')}`;
  const ms = until.getTime() - now;
  if (ms <= 0) return 'activo';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `se activa en ${String(hours)} h ${String(minutes)} min`;
}

function Whitelist({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const whitelistAddress = systemContracts.contracts.whitelist.address;
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<WhitelistRequest | null>(null);
  const [pendingDestination, setPendingDestination] = useState<Address | null>(null);
  const [review, setReview] = useState<{ title: string; items: VerifiedOperation[] } | null>(null);

  const [reload, setReload] = useState(0);
  const refresh = () => {
    setReload((n) => n + 1);
  };

  useEffect(() => {
    const alive = { current: true };
    api
      .whitelist(wallet.id)
      .catch(() => ({ entries: [] }))
      .then((backend) => readWhitelist(reader, whitelistAddress, wallet.safe, backend))
      .then((list) => {
        if (alive.current) setDestinations(list);
      })
      .catch((caught: unknown) => {
        if (alive.current) setError(describeError(caught));
      });
    return () => {
      alive.current = false;
    };
  }, [wallet, reader, whitelistAddress, reload]);

  // La activación la decide el contrato con block.timestamp: la cuenta regresiva usa la hora de la cadena.
  const now = useChainNow(reader);

  const requestAdd = useAsyncAction(
    useCallback(
      async (destinationText: string, label: string) => {
        const destination = parseDestination(destinationText);
        setPendingDestination(destination);
        setRequest(await api.requestWhitelistDestination(unlocked.platform, wallet.id, { destination, label }));
      },
      [unlocked, wallet.id],
    ),
  );

  const confirmAdd = useAsyncAction(
    useCallback(
      async (code: string) => {
        if (!request || !pendingDestination) return;
        await releasePrepared(api, unlocked.platform);
        const { operation } = await api.confirmWhitelistRequest(unlocked.platform, request.id, code);
        const verified = await verifiedOrReleased(api, unlocked.platform, [operation], async () =>
          verifyPrepared(operation, {
            safe: wallet.safe,
            chainId: 8453,
            onchainNonce: await onchainNonce(reader, wallet.safe),
            build: (n) => addDestinationCall(whitelistAddress, pendingDestination, n),
          }),
        );
        setReview({ title: 'Agregar el destino a tu whitelist', items: [verified] });
      },
      [request, pendingDestination, unlocked, reader, wallet.safe, whitelistAddress],
    ),
  );

  const remove = useAsyncAction(
    useCallback(
      async (destination: Address) => {
        await releasePrepared(api, unlocked.platform);
        const operation = await api.removeWhitelistDestination(unlocked.platform, wallet.id, destination);
        const verified = await verifiedOrReleased(api, unlocked.platform, [operation], async () =>
          verifyPrepared(operation, {
            safe: wallet.safe,
            chainId: 8453,
            onchainNonce: await onchainNonce(reader, wallet.safe),
            build: (n) => removeDestinationCall(whitelistAddress, destination, n),
          }),
        );
        setReview({ title: 'Quitar el destino de tu whitelist', items: [verified] });
      },
      [unlocked, wallet, reader, whitelistAddress],
    ),
  );

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="whitelist-title">
        <h1 id="whitelist-title">Whitelist</h1>
        <p>Sólo podés enviar a destinos de tu whitelist, y cada uno se activa 24 h después de agregarlo.</p>
        {error && <Notice tone="error">{error}</Notice>}
        {destinations === null && !error && <p className="muted">Leyendo tu whitelist en Base…</p>}
        {destinations?.length === 0 && <p className="muted">Todavía no agregaste destinos.</p>}
        <ul className="destinations">
          {destinations?.map((d) => (
            <li key={d.address} data-destination={d.address} data-active={String(d.active)}>
              <strong>{d.label ?? 'Sin nombre'}</strong> <AddressText address={d.address} /> ·{' '}
              {d.active ? 'Activo' : remaining(d.activatesAt, now)}{' '}
              <button
                type="button"
                className="button button--link"
                disabled={remove.pending}
                aria-busy={remove.pending}
                onClick={() => void remove.run(d.address)}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
        {remove.error && <Notice tone="error">{remove.error}</Notice>}
      </section>
      {!review && (
        <section className="card stack" aria-labelledby="add-title">
          <h2 id="add-title">Agregar un destino</h2>
          {!request ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                void requestAdd.run(formValue(form, 'destination'), formValue(form, 'label').trim());
              }}
            >
              <Field label="Dirección en Base" name="destination" autoComplete="off" spellCheck={false} required />
              <Field label="Nombre (para reconocerlo)" name="label" maxLength={64} required />
              {requestAdd.error && <Notice tone="error">{requestAdd.error}</Notice>}
              <button type="submit" className="button" disabled={requestAdd.pending} aria-busy={requestAdd.pending}>
                Pedir el código por email
              </button>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmAdd.run(formValue(event.currentTarget, 'code').trim());
              }}
            >
              {pendingDestination && (
                <p>
                  Revisá la dirección completa: <AddressText address={pendingDestination} />
                </p>
              )}
              <Field
                label="Código del email (8 dígitos)"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
              {confirmAdd.error && <Notice tone="error">{confirmAdd.error}</Notice>}
              <button type="submit" className="button" disabled={confirmAdd.pending} aria-busy={confirmAdd.pending}>
                Confirmar el código
              </button>
            </form>
          )}
        </section>
      )}
      {review && (
        <OperationReview
          title={review.title}
          items={review.items}
          unlocked={unlocked}
          decode={decodeContext(wallet.safe)}
          onSettled={() => {
            setRequest(null);
            setPendingDestination(null);
            refresh();
          }}
          onCancel={() => {
            setReview(null);
            setRequest(null);
            setPendingDestination(null);
          }}
        />
      )}
    </div>
  );
}

export function WhitelistPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Whitelist ctx={ctx} />}</SafeGate>;
}
