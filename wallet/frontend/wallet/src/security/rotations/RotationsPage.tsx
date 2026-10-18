// `/security/rotations` (P18.T09 y P18.T09.b): rotaciones pendientes leídas de la cadena con su cuenta regresiva,
// cancelación con la firma EIP-712 de U (al relay de la plataforma o exportada para `cancelWithSignature` desde
// cualquier wallet), ejecución de las maduras y el pedido de rotación de S de la plataforma (motivo, S′ con su
// atestación verificada con la clave fijada, propuesta firmada por U y, tras proponer, S′ leída del timelock).
import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, isAddressEqual } from 'viem';
import type { Rotation } from '../../api/wallet-api.ts';
import { api } from '../../app/services.ts';
import { iSafeAbi } from '../../chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../../chain/abis/RotationTimelock.ts';
import { verifyPrepared, type VerifiedOperation } from '../../chain/safe-tx.ts';
import { systemContracts } from '../../config/index.ts';
import { useChainNow } from '../../chain/ChainNow.tsx';
import { decodeContext, onchainNonce } from '../../operations/context.ts';
import { OperationReview } from '../../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../../operations/prepared.ts';
import { verifySignerKeyAttestation } from '../../safe/attestation.ts';
import { SafeGate, type OperatingWallet } from '../../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../../session/context.tsx';
import { AddressText } from '../../ui/AddressText.tsx';
import { downloadText } from '../../ui/download.ts';
import { describeError } from '../../ui/errors.ts';
import { Notice, useAsyncAction } from '../../ui/forms.tsx';
import {
  assertCancelTypedData,
  cancelRotationTypedData,
  executeCall,
  proposeCall,
  readPendingProposals,
  signCancellation,
  type PendingProposal,
} from './rotations.ts';

const ROLE_TEXT: Record<string, string> = {
  U: 'clave de usuario (U)',
  R: 'clave de recuperación (R)',
  S: 'clave de la plataforma (S)',
  GUARD: 'Guard de seguridad',
  MODULE_GUARD: 'guard de módulos',
};
const REASON_TEXT: Record<string, string> = {
  SHARD_MIGRATION: 'migración de la clave a otro servidor de firma de la plataforma',
  HSM_MIGRATION: 'migración de la clave a un módulo de hardware (HSM)',
  KEY_COMPROMISE: 'posible compromiso del servidor que guarda la clave',
  MAINTENANCE: 'mantenimiento preventivo de la clave',
};
const STATUS_TEXT: Record<Rotation['status'], string> = {
  DRAFT: 'Pedida, sin proponer',
  AWAITING_SIGNATURE: 'Esperando tu firma',
  PROPOSING: 'Proponiendo',
  PENDING_TIMELOCK: 'En el timelock (48 h)',
  READY_TO_EXECUTE: 'Lista para ejecutar',
  EXECUTING: 'Ejecutando',
  EXECUTED: 'Ejecutada',
  CANCELLED: 'Cancelada',
  FAILED: 'Falló',
};

function Rotations({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked, state } = ctx;
  const timelock = systemContracts.contracts.timelock.address;
  const [pending, setPending] = useState<PendingProposal[] | null>(null);
  const [history, setHistory] = useState<Rotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ title: string; item: VerifiedOperation } | null>(null);
  const [reviewDone, setReviewDone] = useState(false);
  const [cancelled, setCancelled] = useState<Record<string, string>>({});
  const [verifiedAttestation, setVerifiedAttestation] = useState<{ id: string; error: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = () => {
    setReload((n) => n + 1);
  };

  useEffect(() => {
    const alive = { current: true };
    Promise.all([readPendingProposals(reader, timelock, wallet.safe), api.listRotations(wallet.id)])
      .then(([onchain, list]) => {
        if (!alive.current) return;
        setPending(onchain);
        setHistory(list.items);
      })
      .catch((caught: unknown) => {
        if (alive.current) setError(describeError(caught));
      });
    return () => {
      alive.current = false;
    };
  }, [reader, timelock, wallet, reload]);

  // La madurez la decide el timelock con block.timestamp: se compara con la hora de la cadena.
  const now = useChainNow(reader);

  const request = history.find((r) => r.role === 'S' && r.status === 'DRAFT' && r.requestReason !== null) ?? null;

  useEffect(() => {
    if (!request?.newKeyAttestation) return;
    const id = request.id;
    verifySignerKeyAttestation(request.newKeyAttestation, systemContracts.signerAttestationPublicKey, {
      walletId: wallet.id,
      executor: request.newKey,
    })
      .then(() => {
        setVerifiedAttestation({ id, error: null });
      })
      .catch((caught: unknown) => {
        setVerifiedAttestation({ id, error: describeError(caught) });
      });
  }, [request, wallet.id]);

  /** 'ok', un error para mostrar o null mientras se verifica. */
  const attested: string | null = !request
    ? null
    : !request.newKeyAttestation
      ? 'La plataforma no mandó la atestación de la clave nueva.'
      : verifiedAttestation?.id === request.id
        ? (verifiedAttestation.error ?? 'ok')
        : null;

  /**
   * La rotación del backend de una propuesta on-chain. El backend la registra al ver el evento (unos segundos después
   * de que se mina): si todavía no está en la lista cargada, se vuelve a pedir antes de darla por desconocida.
   */
  const rotationFor = useCallback(
    async (proposal: PendingProposal): Promise<Rotation | null> => {
      const match = (items: readonly Rotation[]) =>
        items.find((r) => r.proposalId !== null && r.proposalId.toLowerCase() === proposal.id.toLowerCase()) ?? null;
      const known = match(history);
      if (known) return known;
      const { items } = await api.listRotations(wallet.id);
      setHistory(items);
      return match(items);
    },
    [history, wallet.id],
  );

  const cancel = useAsyncAction(
    useCallback(
      async (proposal: PendingProposal, mode: 'relay' | 'export') => {
        const own = cancelRotationTypedData(timelock, proposal.id, wallet.safe);
        const rotation = await rotationFor(proposal);
        assertCancelTypedData(rotation?.cancelTypedData ?? null, own);
        const signature = await signCancellation(unlocked, own);
        if (mode === 'export') {
          const call = encodeFunctionData({
            abi: rotationTimelockAbi,
            functionName: 'cancelWithSignature',
            args: [proposal.id, signature],
          });
          downloadText(
            `mtw-cancel-${proposal.id.slice(2, 10)}.json`,
            `${JSON.stringify({ chainId: 8453, timelock, proposalId: proposal.id, safe: wallet.safe, signature, call }, null, 2)}\n`,
          );
          setCancelled((current) => ({
            ...current,
            [proposal.id]: 'Firma exportada: transmitila con cualquier wallet.',
          }));
          return;
        }
        if (!rotation) throw new Error('La plataforma no conoce esta propuesta: exportá la firma.');
        await api.relayRotationCancellation(rotation.id, signature);
        setCancelled((current) => ({
          ...current,
          [proposal.id]: 'Cancelación enviada: se confirma con el evento on-chain.',
        }));
      },
      [timelock, wallet.safe, unlocked, rotationFor],
    ),
  );

  const execute = useAsyncAction(
    useCallback(
      async (proposal: PendingProposal) => {
        const rotation = await rotationFor(proposal);
        if (!rotation) {
          throw new Error('La plataforma todavía no registró esta propuesta: probá de nuevo en unos segundos.');
        }
        await releasePrepared(api, unlocked.platform);
        const { operation } = await api.prepareRotationExecution(unlocked.platform, rotation.id);
        const item = await verifiedOrReleased(api, unlocked.platform, [operation], async () => {
          const [nonce, owners] = await Promise.all([
            onchainNonce(reader, wallet.safe),
            reader.readContract({ address: wallet.safe, abi: iSafeAbi, functionName: 'getOwners' }),
          ]);
          return verifyPrepared(operation, {
            safe: wallet.safe,
            chainId: 8453,
            onchainNonce: nonce,
            build: (n) => executeCall(wallet.safe, proposal, owners, n),
          });
        });
        setReviewDone(false);
        setReview({ title: `Ejecutar la rotación de tu ${ROLE_TEXT[proposal.role] ?? proposal.role}`, item });
      },
      [unlocked, reader, wallet.safe, rotationFor],
    ),
  );

  const proposeExecutor = useAsyncAction(
    useCallback(async () => {
      if (!request || attested !== 'ok') return;
      await releasePrepared(api, unlocked.platform);
      const { rotation, operation } = await api.proposeRotation(unlocked.platform, wallet.id, 'S');
      const item = await verifiedOrReleased(api, unlocked.platform, [operation], async () => {
        if (!isAddressEqual(rotation.newKey, request.newKey))
          throw new Error('La plataforma propone otra clave que la pedida.');
        return verifyPrepared(operation, {
          safe: wallet.safe,
          chainId: 8453,
          onchainNonce: await onchainNonce(reader, wallet.safe),
          build: (n) => proposeCall(timelock, 'S', state.roles.executor, request.newKey, n),
        });
      });
      setReviewDone(false);
      setReview({ title: 'Proponer la rotación de la clave de la plataforma (S)', item });
    }, [request, attested, unlocked, wallet, reader, timelock, state.roles.executor]),
  );

  return (
    <div className="stack">
      {request && !review && (
        <section className="card stack" aria-labelledby="s-request-title" data-s-request={request.id}>
          <h2 id="s-request-title">La plataforma pidió rotar su clave (S)</h2>
          <p>Motivo: {REASON_TEXT[request.requestReason ?? ''] ?? request.requestReason}</p>
          <dl className="summary">
            <dt>Clave actual (on-chain)</dt>
            <dd>
              <AddressText address={state.roles.executor} />
            </dd>
            <dt>Clave nueva</dt>
            <dd>
              <AddressText address={request.newKey} />
            </dd>
          </dl>
          {attested === 'ok' && (
            <Notice tone="success">La clave nueva está atestada por el signer de esta versión.</Notice>
          )}
          {attested !== null && attested !== 'ok' && <Notice tone="error">{attested}</Notice>}
          {proposeExecutor.error && <Notice tone="error">{proposeExecutor.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={attested !== 'ok' || proposeExecutor.pending}
            onClick={() => void proposeExecutor.run()}
          >
            Revisar y firmar la propuesta
          </button>
        </section>
      )}
      {review && (
        <>
          <OperationReview
            title={review.title}
            items={[review.item]}
            unlocked={unlocked}
            decode={decodeContext(wallet.safe)}
            onSettled={() => {
              setReviewDone(true);
              refresh();
            }}
            onCancel={() => {
              setReview(null);
            }}
          />
          {reviewDone && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setReview(null);
                setReviewDone(false);
              }}
            >
              Volver a las rotaciones
            </button>
          )}
        </>
      )}
      <section className="card stack" aria-labelledby="pending-title">
        <h1 id="pending-title">Rotaciones pendientes (leídas de Base)</h1>
        {error && <Notice tone="error">{error}</Notice>}
        {pending === null && !error && <p className="muted">Leyendo el timelock…</p>}
        {pending?.length === 0 && <p className="muted">No hay rotaciones pendientes.</p>}
        <ul className="rotations">
          {pending?.map((p) => {
            const mature = now !== null && p.executableAt.getTime() <= now;
            return (
              <li key={p.id} className="stack" data-proposal={p.id} data-role={p.role}>
                <p>
                  <strong>{ROLE_TEXT[p.role] ?? p.role}</strong>: <AddressText address={p.oldValue} /> →{' '}
                  <AddressText address={p.newValue} />
                </p>
                <p>
                  {mature
                    ? 'Se puede ejecutar.'
                    : `Se puede ejecutar desde el ${p.executableAt.toLocaleString('es-AR')}.`}
                </p>
                {cancelled[p.id] ? (
                  <Notice tone="success">{cancelled[p.id]}</Notice>
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={cancel.pending}
                      onClick={() => void cancel.run(p, 'relay')}
                    >
                      Cancelar con mi firma
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={cancel.pending}
                      onClick={() => void cancel.run(p, 'export')}
                    >
                      Exportar la firma de cancelación
                    </button>
                    {mature && (
                      <button
                        type="button"
                        className="button"
                        disabled={execute.pending}
                        onClick={() => void execute.run(p)}
                      >
                        Ejecutar
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {cancel.error && <Notice tone="error">{cancel.error}</Notice>}
        {execute.error && <Notice tone="error">{execute.error}</Notice>}
      </section>
      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">Historial</h2>
        {history.length === 0 ? (
          <p className="muted">Sin rotaciones.</p>
        ) : (
          <ul className="rotations">
            {history.map((r) => (
              <li key={r.id} data-rotation={r.id} data-status={r.status}>
                {ROLE_TEXT[r.role] ?? r.role}: {STATUS_TEXT[r.status]} · {new Date(r.createdAt).toLocaleString('es-AR')}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function RotationsPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Rotations ctx={ctx} />}</SafeGate>;
}
