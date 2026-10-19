// `/rotations` (P19.T05): rotaciones pendientes leídas del timelock on-chain. R las cancela con su firma EIP-712
// (CancelRotation): por el relay del backend, transmitiendo `cancelWithSignature` con su wallet externa (paga el gas) o
// exportando la calldata para cualquier relayer. R ejecuta las maduras de U y S y propone la S′ que pidió la plataforma
// (motivo + atestación verificada con la clave fijada en el build).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddressEqual, type Hex } from 'viem';
import type { Rotation } from '../api/recovery-api.ts';
import { api, pinned, reader } from '../app/services.ts';
import {
  cancelWithSignatureData,
  executeCall,
  pendingProposals,
  proposeCall,
  safeNonce,
  safeOwners,
  type PendingProposal,
} from '../chain/rotations.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { useChainNow } from '../chain/time.ts';
import { importAttestationKey, verifySignerKeyAttestation } from '../crypto/attestation.ts';
import { cancelRotation } from '../crypto/typed-data.ts';
import { strictSignature } from '../enroll/enrollment.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, SETTLED_STATES, verifiedOrReleased } from '../operations/sign.ts';
import { useSensitiveScreen } from '../session/context.tsx';
import { RecoveryGate, type RecoveryContext } from '../session/RecoveryGate.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { downloadText } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';

const KIND_TEXT: Record<string, string> = {
  U: 'Clave de usuario (U)',
  R: 'Clave de recuperación (R)',
  S: 'Clave de la plataforma (S)',
  GUARD: 'Guard de seguridad',
  MODULE_GUARD: 'Guard de módulos',
};
const REASON_TEXT: Record<string, string> = {
  SHARD_MIGRATION: 'migración de la clave a otro servidor de firma de la plataforma',
  HSM_MIGRATION: 'migración de la clave a un módulo de hardware (HSM)',
  KEY_COMPROMISE: 'posible compromiso del servidor que guarda la clave',
  MAINTENANCE: 'mantenimiento preventivo de la clave',
};

function Rotations({ ctx }: { ctx: RecoveryContext }) {
  const { platform, signer, walletId, safe, checked } = ctx;
  const timelock = pinned.system.contracts.timelock.address;
  const [pending, setPending] = useState<PendingProposal[] | null>(null);
  const [history, setHistory] = useState<Rotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ title: string; item: VerifiedOperation } | null>(null);
  const [attested, setAttested] = useState<{ id: string; error: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const now = useChainNow(reader);

  useEffect(() => {
    let alive = true;
    Promise.all([pendingProposals(reader, timelock, safe), api.rotations(walletId)])
      .then(([onchain, list]) => {
        if (!alive) return;
        setPending(onchain);
        setHistory(list.items);
      })
      .catch((caught: unknown) => {
        if (alive) setError(describeError(caught));
      });
    return () => {
      alive = false;
    };
  }, [walletId, safe, timelock, reload]);

  const request = useMemo(
    () => history.find((r) => r.role === 'S' && r.status === 'DRAFT' && r.requestReason !== null) ?? null,
    [history],
  );

  useEffect(() => {
    if (!request?.newKeyAttestation) return;
    const { id, newKeyAttestation, newKey } = request;
    importAttestationKey(pinned.system.signerAttestationPublicKey)
      .then((key) => verifySignerKeyAttestation(newKeyAttestation, key, { walletId, executor: newKey }))
      .then(() => {
        setAttested({ id, error: null });
      })
      .catch((caught: unknown) => {
        setAttested({ id, error: describeError(caught) });
      });
  }, [request, walletId]);

  const rotationFor = useCallback(
    async (proposal: PendingProposal): Promise<Rotation | null> => {
      const match = (items: readonly Rotation[]) =>
        items.find((r) => r.proposalId !== null && r.proposalId.toLowerCase() === proposal.id.toLowerCase()) ?? null;
      const known = match(history);
      if (known) return known;
      const { items } = await api.rotations(walletId);
      setHistory(items);
      return match(items);
    },
    [history, walletId],
  );

  const cancel = useAsyncAction(
    useCallback(
      async (proposal: PendingProposal, mode: 'relay' | 'send' | 'export') => {
        const signature = strictSignature(
          await signer.signTypedData(cancelRotation(timelock, { proposalId: proposal.id, safe })),
        );
        const data = cancelWithSignatureData(proposal.id, signature);
        if (mode === 'export') {
          downloadText(
            `mtw-cancel-${proposal.id.slice(2, 10)}.json`,
            `${JSON.stringify({ chainId: 8453, to: timelock, proposalId: proposal.id, safe, signature, data }, null, 2)}\n`,
          );
          setNotes((n) => ({
            ...n,
            [proposal.id]: 'Firma exportada: cualquier cuenta puede transmitir la calldata al timelock.',
          }));
          return;
        }
        if (mode === 'send') {
          if (!signer.sendTransaction)
            throw new Error('Para transmitirla vos mismo hace falta una wallet externa conectada.');
          const hash: Hex = await signer.sendTransaction({ to: timelock, data });
          setNotes((n) => ({
            ...n,
            [proposal.id]: `Cancelación transmitida (${hash.slice(0, 10)}…): se confirma con el evento en Base.`,
          }));
          return;
        }
        const rotation = await rotationFor(proposal);
        if (!rotation) throw new Error('La plataforma no conoce esta propuesta: exportá la firma o transmitila vos.');
        await api.relayRotationCancellation(rotation.id, signature);
        setNotes((n) => ({ ...n, [proposal.id]: 'Cancelación enviada: se confirma con el evento en Base.' }));
      },
      [signer, timelock, safe, rotationFor],
    ),
  );

  const execute = useAsyncAction(
    useCallback(
      async (proposal: PendingProposal) => {
        const rotation = await rotationFor(proposal);
        if (!rotation)
          throw new Error('La plataforma todavía no registró esta propuesta: probá de nuevo en unos segundos.');
        await releasePrepared(api, platform);
        const { operation } = await api.prepareRotationExecution(platform.auth, rotation.id);
        const item = await verifiedOrReleased(api, platform, [operation], async () => {
          const [nonce, owners] = await Promise.all([safeNonce(reader, safe), safeOwners(reader, safe)]);
          return verifyPrepared(operation, {
            safe,
            chainId: 8453,
            onchainNonce: nonce,
            build: (n) => executeCall(safe, proposal, owners, n),
          });
        });
        setReview({ title: `Revisá la ejecución de la rotación: ${KIND_TEXT[proposal.kind] ?? proposal.kind}`, item });
      },
      [rotationFor, platform, safe],
    ),
  );

  const proposeExecutor = useAsyncAction(
    useCallback(async () => {
      if (!request || attested?.id !== request.id || attested.error !== null) return;
      await releasePrepared(api, platform);
      const { rotation, operation } = await api.proposeRotation(platform.auth, walletId, 'S');
      const item = await verifiedOrReleased(api, platform, [operation], async () => {
        if (!isAddressEqual(rotation.newKey, request.newKey))
          throw new Error('La plataforma propone otra clave que la pedida.');
        return verifyPrepared(operation, {
          safe,
          chainId: 8453,
          onchainNonce: await safeNonce(reader, safe),
          build: (n) => proposeCall(timelock, 'S', checked.roles.executor, request.newKey, n),
        });
      });
      setReview({ title: 'Revisá la propuesta de rotación de la clave de la plataforma (S)', item });
    }, [request, attested, platform, walletId, safe, timelock, checked.roles.executor]),
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

  return (
    <div className="stack">
      {request && (
        <section className="card stack" aria-labelledby="s-request-title" data-s-request={request.id}>
          <h2 id="s-request-title">La plataforma pidió rotar su clave (S)</h2>
          <p>Motivo: {REASON_TEXT[request.requestReason ?? ''] ?? request.requestReason}</p>
          <p>
            Dirección de la clave nueva: <AddressText address={request.newKey} />
          </p>
          {attested?.id === request.id && attested.error === null && (
            <Notice tone="success">La clave nueva está atestada por el signer de esta versión.</Notice>
          )}
          {attested?.id === request.id && attested.error !== null && <Notice tone="error">{attested.error}</Notice>}
          {proposeExecutor.error && <Notice tone="error">{proposeExecutor.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={attested?.id !== request.id || attested.error !== null || proposeExecutor.pending}
            onClick={() => void proposeExecutor.run()}
          >
            Revisar y firmar la propuesta
          </button>
        </section>
      )}
      <section className="card stack" aria-labelledby="pending-title">
        <h1 id="pending-title">Rotaciones pendientes (leídas de Base)</h1>
        {error && <Notice tone="error">{error}</Notice>}
        {pending === null && !error && <p className="muted">Leyendo el timelock…</p>}
        {pending?.length === 0 && <p className="muted">No hay rotaciones pendientes.</p>}
        <ul className="rotations">
          {pending?.map((p) => {
            const mature = now !== null && p.executableAt.getTime() <= now;
            const canExecute = mature && (p.kind === 'U' || p.kind === 'S');
            return (
              <li key={p.id} className="stack" data-proposal={p.id} data-kind={p.kind}>
                <p>
                  <strong>{KIND_TEXT[p.kind] ?? p.kind}</strong>: de la dirección <AddressText address={p.oldValue} /> a
                  la dirección <AddressText address={p.newValue} />
                </p>
                <p>
                  {mature
                    ? 'Se puede ejecutar.'
                    : `Se puede ejecutar desde el ${p.executableAt.toLocaleString('es-AR')}.`}
                </p>
                {notes[p.id] ? (
                  <Notice tone="success">{notes[p.id]}</Notice>
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
                    {signer.sendTransaction && (
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={cancel.pending}
                        onClick={() => void cancel.run(p, 'send')}
                      >
                        Cancelar pagando el gas con mi wallet
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={cancel.pending}
                      onClick={() => void cancel.run(p, 'export')}
                    >
                      Exportar la firma de cancelación
                    </button>
                    {canExecute && (
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
    </div>
  );
}

export function RotationsPage() {
  useSensitiveScreen();
  return <RecoveryGate>{(ctx) => <Rotations ctx={ctx} />}</RecoveryGate>;
}
