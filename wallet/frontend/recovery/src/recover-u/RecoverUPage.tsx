// `/recover-u` (P19.T04): reemplazar U perdida por U′. La Wallet registró U′ (con su KeyAcceptance) y dejó la rotación
// en borrador para que R la proponga. Acá: U′ pendiente (para compararla con la que muestra la Wallet), R firma la
// propuesta que arma la app (R + S, timelock de 48 h), cuenta regresiva con la hora de la cadena y, al madurar, R firma
// la ejecución (swapOwner con el owner anterior leído de la cadena).
import { useCallback, useEffect, useState } from 'react';
import { isAddressEqual } from 'viem';
import type { Rotation } from '../api/recovery-api.ts';
import { api, pinned, reader } from '../app/services.ts';
import {
  executeCall,
  pendingProposals,
  proposeCall,
  safeOwners,
  safeNonce,
  type PendingProposal,
} from '../chain/rotations.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { useChainNow } from '../chain/time.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, SETTLED_STATES, verifiedOrReleased } from '../operations/sign.ts';
import { useSensitiveScreen } from '../session/context.tsx';
import { RecoveryGate, type RecoveryContext } from '../session/RecoveryGate.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';

function RecoverU({ ctx }: { ctx: RecoveryContext }) {
  const { platform, signer, walletId, safe, checked } = ctx;
  const timelock = pinned.system.contracts.timelock.address;
  const [rotations, setRotations] = useState<Rotation[] | null>(null);
  const [pending, setPending] = useState<PendingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ title: string; item: VerifiedOperation } | null>(null);
  const [reload, setReload] = useState(0);
  const now = useChainNow(reader);

  useEffect(() => {
    let alive = true;
    Promise.all([api.rotations(walletId), pendingProposals(reader, timelock, safe)])
      .then(([list, proposals]) => {
        if (!alive) return;
        setRotations(list.items);
        setPending(proposals.find((p) => p.kind === 'U') ?? null);
      })
      .catch((caught: unknown) => {
        if (alive) setError(describeError(caught));
      });
    return () => {
      alive = false;
    };
  }, [walletId, safe, timelock, reload]);

  const draft = rotations?.find((r) => r.role === 'U' && r.status === 'DRAFT' && r.initiatedBy === 'R') ?? null;
  const live =
    rotations?.find((r) => r.role === 'U' && ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'].includes(r.status)) ?? null;

  const propose = useAsyncAction(
    useCallback(async () => {
      if (!draft) return;
      await releasePrepared(api, platform);
      const { rotation, operation } = await api.proposeRotation(platform.auth, walletId, 'U');
      const item = await verifiedOrReleased(api, platform, [operation], async () => {
        if (!isAddressEqual(rotation.newKey, draft.newKey))
          throw new Error('La plataforma propone otra U′ que la registrada.');
        return verifyPrepared(operation, {
          safe,
          chainId: 8453,
          onchainNonce: await safeNonce(reader, safe),
          build: (n) => proposeCall(timelock, 'U', checked.roles.userKey, draft.newKey, n),
        });
      });
      setReview({ title: 'Proponer el reemplazo de tu clave de usuario (U)', item });
    }, [draft, platform, walletId, safe, timelock, checked.roles.userKey]),
  );

  const execute = useAsyncAction(
    useCallback(async () => {
      if (!pending) return;
      const rotation =
        live ??
        (await api.rotations(walletId)).items.find((r) => r.proposalId?.toLowerCase() === pending.id.toLowerCase());
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
          build: (n) => executeCall(safe, pending, owners, n),
        });
      });
      setReview({ title: 'Ejecutar el reemplazo de tu clave de usuario (U)', item });
    }, [pending, live, walletId, platform, safe]),
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

  const mature = pending !== null && now !== null && pending.executableAt.getTime() <= now;
  return (
    <section className="card stack" aria-labelledby="recover-u-title">
      <h1 id="recover-u-title">Recuperar tu clave de usuario (U)</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {rotations === null && !error && <p className="muted">Leyendo tus rotaciones…</p>}
      <p>
        U actual (leída del Guard): <AddressText address={checked.roles.userKey} />
      </p>
      {pending ? (
        <div className="stack" data-pending-u={pending.id}>
          <p>
            Propuesta en el timelock: U → <AddressText address={pending.newValue} />
          </p>
          <p>
            {mature
              ? 'Se puede ejecutar.'
              : `Se puede ejecutar desde el ${pending.executableAt.toLocaleString('es-AR')} (hora de la red).`}
          </p>
          {execute.error && <Notice tone="error">{execute.error}</Notice>}
          {mature && (
            <button type="button" className="button" disabled={execute.pending} onClick={() => void execute.run()}>
              Ejecutar el reemplazo
            </button>
          )}
        </div>
      ) : draft ? (
        <div className="stack" data-draft-u={draft.id}>
          <p>
            La app Wallet registró esta clave U′ para reemplazar la tuya. Compará la dirección completa con la que
            muestra la Wallet:
          </p>
          <p>
            <AddressText address={draft.newKey} />
          </p>
          {propose.error && <Notice tone="error">{propose.error}</Notice>}
          <button type="button" className="button" disabled={propose.pending} onClick={() => void propose.run()}>
            Coincide: revisar y firmar la propuesta
          </button>
        </div>
      ) : (
        rotations !== null && (
          <Notice>No hay un reemplazo de U pendiente. Empezalo desde la app Wallet («Perdí mi Password U»).</Notice>
        )
      )}
    </section>
  );
}

export function RecoverUPage() {
  useSensitiveScreen();
  return <RecoveryGate>{(ctx) => <RecoverU ctx={ctx} />}</RecoveryGate>;
}
