// `/whitelist` (P18.T05): destinos leídos de la cadena (con los labels del backend, entre «»), cuenta regresiva de
// activación con la alerta in-app de ADR-006 (si no lo agregaste vos o no es la dirección que esperabas, quitalo), alta
// (código por email, comparación de la dirección completa con la del email y con la que pasó el destinatario por otro
// medio —ESC-16: si se sustituyó antes de llegar a la app, app y email coinciden igual—, firma de U de la SafeTx armada
// por la app) y baja. Un label no puede imitar un nombre de la app (operations/names.ts). El inicio puede abrir
// directamente la baja de un destino en activación (estado de navegación `remove`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Address } from 'viem';
import type { WhitelistRequest } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { systemContracts } from '../config/index.ts';
import { useChainNow } from '../chain/ChainNow.tsx';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { labelProblem, labelsOf, userLabel } from '../operations/names.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../operations/prepared.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen, useSession } from '../session/context.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import {
  activationText,
  addDestinationCall,
  parseDestination,
  readWhitelist,
  removeDestinationCall,
  type Destination,
} from './whitelist.ts';

/** Estado de navegación con el que el inicio pide la baja de un destino (alerta de activación). */
export interface RemoveIntent {
  remove: Address;
}

function removeIntent(state: unknown): Address | null {
  if (typeof state !== 'object' || state === null || !('remove' in state)) return null;
  const value = state.remove;
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : null;
}

interface Review {
  kind: 'add' | 'remove';
  items: VerifiedOperation[];
  labels: Map<string, string>;
}

function Whitelist({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const { user } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const whitelistAddress = systemContracts.contracts.whitelist.address;
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<WhitelistRequest | null>(null);
  const [pending, setPending] = useState<{ address: Address; label: string } | null>(null);
  const [review, setReview] = useState<Review | null>(null);

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
        const problem = labelProblem(label);
        if (problem !== null) throw new Error(problem);
        setPending({ address: destination, label });
        setRequest(await api.requestWhitelistDestination(unlocked.platform, wallet.id, { destination, label }));
      },
      [unlocked, wallet.id],
    ),
  );

  const confirmAdd = useAsyncAction(
    useCallback(
      async (code: string) => {
        if (!request || !pending) return;
        await releasePrepared(api, unlocked.platform);
        const { operation } = await api.confirmWhitelistRequest(unlocked.platform, request.id, code);
        const verified = await verifiedOrReleased(api, unlocked.platform, [operation], async () =>
          verifyPrepared(operation, {
            safe: wallet.safe,
            chainId: 8453,
            onchainNonce: await onchainNonce(reader, wallet.safe),
            build: (n) => addDestinationCall(whitelistAddress, pending.address, n),
          }),
        );
        setReview({ kind: 'add', items: [verified], labels: labelsOf([pending]) });
      },
      [request, pending, unlocked, reader, wallet.safe, whitelistAddress],
    ),
  );

  const remove = useAsyncAction(
    useCallback(
      async (destination: Address, labels: Map<string, string>) => {
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
        setReview({ kind: 'remove', items: [verified], labels });
      },
      [unlocked, wallet, reader, whitelistAddress],
    ),
  );

  // Baja pedida desde la alerta del inicio: se prepara una sola vez, cuando la lista on-chain ya está leída.
  const requestedRemoval = removeIntent(location.state);
  const handledRemoval = useRef<string | null>(null);
  const runRemove = remove.run;
  useEffect(() => {
    if (requestedRemoval === null || destinations === null || handledRemoval.current === requestedRemoval) return;
    handledRemoval.current = requestedRemoval;
    void navigate(location.pathname, { replace: true, state: null });
    const target = destinations.find((d) => d.address.toLowerCase() === requestedRemoval.toLowerCase());
    if (target) void runRemove(target.address, labelsOf(destinations));
  }, [requestedRemoval, destinations, navigate, location.pathname, runRemove]);

  const startOver = () => {
    setRequest(null);
    setPending(null);
    requestAdd.setError(null);
    confirmAdd.setError(null);
  };

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
              <strong>{d.label === null ? 'Sin nombre' : userLabel(d.label)}</strong>{' '}
              <AddressText address={d.address} /> · {d.active ? 'Activo.' : `${activationText(d.activatesAt, now)}.`}
              {!d.active && (
                <span className="muted" data-activation-alert>
                  {' '}
                  Si no lo agregaste vos o no es la dirección que esperabas, quitalo antes de que se active.
                </span>
              )}{' '}
              <button
                type="button"
                className="button button--link"
                disabled={remove.pending}
                aria-busy={remove.pending}
                onClick={() => void remove.run(d.address, labelsOf(destinations))}
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
          {/* Cada paso es otro formulario (key): React no reutiliza el campo del nombre como campo del código. */}
          {!request ? (
            <form
              key="request"
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
              key="confirm"
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmAdd.run(formValue(event.currentTarget, 'code').trim());
              }}
            >
              <p>
                Te mandamos un código por email{user ? ` a ${user.email}` : ''}. El email muestra la dirección que estás
                por agregar.
              </p>
              {pending && (
                <Notice tone="warning">
                  <p>
                    Antes de escribir el código, compará los 10 grupos de esta dirección con la del email y con la que
                    te pasó el destinatario por otro medio (no la copies de esta pantalla ni del email):
                  </p>
                  <p>
                    <strong>{userLabel(pending.label)}</strong> <AddressText address={pending.address} />
                  </p>
                  <p>
                    Si algún grupo no coincide, no escribas el código: alguien pudo cambiar la dirección antes de que
                    llegara a esta app (en el portapapeles o en el mensaje en que te la pasaron) o en la app misma.
                  </p>
                </Notice>
              )}
              <Field
                label="Código del email (8 dígitos)"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
              {confirmAdd.error && <Notice tone="error">{confirmAdd.error}</Notice>}
              <div className="actions">
                <button type="submit" className="button" disabled={confirmAdd.pending} aria-busy={confirmAdd.pending}>
                  Confirmar el código
                </button>
                <button type="button" className="button button--ghost" onClick={startOver}>
                  Empezar de nuevo
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {review && (
        <OperationReview
          title={review.kind === 'add' ? 'Revisá el alta del destino' : 'Revisá la baja del destino'}
          doneTitle={review.kind === 'add' ? 'Destino agregado' : 'Destino quitado'}
          items={review.items}
          unlocked={unlocked}
          decode={decodeContext(wallet.safe)}
          labels={review.labels}
          summary={(success) =>
            review.kind === 'add' ? (
              success ? (
                <p>
                  El alta ya está en un bloque de Base: el destino se activa en 24 h y recién ahí le vas a poder enviar.
                  Mientras tanto lo podés quitar desde la lista de arriba; si no lo agregaste vos o no es la dirección
                  que esperabas, quitalo.
                </p>
              ) : (
                <p>
                  Tiene que ser la misma dirección que mostraba el email y la que te pasó el destinatario por otro medio
                  (no la copies de esta pantalla ni del email). El destino se activa 24 h después de que el alta se
                  incluya en un bloque: recién ahí le podés enviar, y mientras tanto lo podés quitar.
                </p>
              )
            ) : success ? (
              <p>La baja ya está en un bloque de Base: ya no le podés enviar a ese destino.</p>
            ) : (
              <p>La baja es inmediata: desde que se incluye en un bloque ya no le podés enviar a ese destino.</p>
            )
          }
          onSettled={() => {
            setRequest(null);
            setPending(null);
            refresh();
          }}
          onCancel={() => {
            setReview(null);
            setRequest(null);
            setPending(null);
          }}
          doneActions={
            <>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setReview(null);
                }}
              >
                {review.kind === 'add' ? 'Agregar otro destino' : 'Volver a la whitelist'}
              </button>
              <Link className="button button--ghost" to="/">
                Volver al inicio
              </Link>
            </>
          }
        />
      )}
    </div>
  );
}

export function WhitelistPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Whitelist ctx={ctx} />}</SafeGate>;
}
