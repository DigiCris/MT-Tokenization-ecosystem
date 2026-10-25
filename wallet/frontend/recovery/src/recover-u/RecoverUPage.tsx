// `/recover-u` (P19.T04): reemplazar U perdida por U′. La Wallet registró U′ (con su KeyAcceptance) y dejó la rotación
// en borrador para que R la proponga. Acá: U′ pendiente, que se confirma comparándola con la que muestra la Wallet
// antes de firmar nada (ConfirmNewUserKey: la del backend no se muestra hasta que coincide, [F-LNK-04]); R firma la
// propuesta que arma la app con la U′ confirmada (R + S, timelock de 48 h), cuenta regresiva con la hora de la cadena y,
// al madurar, R firma la ejecución (swapOwner con el owner anterior leído de la cadena).
import { useCallback, useEffect, useState } from 'react';
import { isAddress, isAddressEqual, type Address } from 'viem';
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
import { sameDraft, type UserKeyDraft } from './compare.ts';
import { ConfirmNewUserKey } from './ConfirmNewUserKey.tsx';

/** El borrador de la rotación de U que dejó la Wallet con «Perdí mi Password U» (lo propone R). */
function userKeyDraft(rotations: readonly Rotation[] | null): UserKeyDraft | null {
  const draft = rotations?.find((r) => r.role === 'U' && r.status === 'DRAFT' && r.initiatedBy === 'R');
  return draft ? { id: draft.id, newKey: draft.newKey } : null;
}

function RecoverU({ ctx }: { ctx: RecoveryContext }) {
  const { platform, signer, walletId, safe, checked } = ctx;
  const timelock = pinned.system.contracts.timelock.address;
  const [rotations, setRotations] = useState<Rotation[] | null>(null);
  const [pending, setPending] = useState<PendingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ title: string; item: VerifiedOperation } | null>(null);
  const [confirmed, setConfirmed] = useState<UserKeyDraft | null>(null);
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

  const draft = userKeyDraft(rotations);
  // La U′ confirmada vale sólo para ese mismo borrador: si la Wallet registró otra, hay que volver a comparar.
  const confirmedKey: Address | null =
    confirmed !== null && draft !== null && sameDraft(confirmed, draft) ? confirmed.newKey : null;
  const live =
    rotations?.find((r) => r.role === 'U' && ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'].includes(r.status)) ?? null;

  const reread = useCallback(async () => {
    const { items } = await api.rotations(walletId);
    setRotations(items);
    return userKeyDraft(items);
  }, [walletId]);

  const propose = useAsyncAction(
    useCallback(async () => {
      if (confirmedKey === null) return;
      await releasePrepared(api, platform);
      const { rotation, operation } = await api.proposeRotation(platform.auth, walletId, 'U');
      const item = await verifiedOrReleased(api, platform, [operation], async () => {
        // La propuesta va hacia la U′ que confirmó el usuario, nunca hacia la que diga el backend ahora (ni su texto).
        if (!isAddress(rotation.newKey, { strict: false }) || !isAddressEqual(rotation.newKey, confirmedKey))
          throw new Error('La plataforma propone otra clave U nueva que la que confirmaste.');
        return verifyPrepared(operation, {
          safe,
          chainId: 8453,
          onchainNonce: await safeNonce(reader, safe),
          build: (n) => proposeCall(timelock, 'U', checked.roles.userKey, confirmedKey, n),
        });
      });
      setReview({ title: 'Revisá la propuesta de reemplazo de tu clave de usuario (U)', item });
    }, [confirmedKey, platform, walletId, safe, timelock, checked.roles.userKey]),
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
      setReview({ title: 'Revisá la ejecución del reemplazo de tu clave de usuario (U)', item });
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
        Dirección de tu clave U actual (leída del Guard): <AddressText address={checked.roles.userKey} />
      </p>
      {pending ? (
        <div className="stack" data-pending-u={pending.id}>
          <p>
            Propuesta en el timelock: reemplazar U por la clave con la dirección{' '}
            <AddressText address={pending.newValue} />
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
          {confirmedKey === null ? (
            <ConfirmNewUserKey draft={draft} reread={reread} onConfirmed={setConfirmed} />
          ) : (
            <>
              <Notice tone="success">
                <span data-u-confirmed="">
                  Dirección de tu clave U nueva (confirmada): <AddressText address={confirmedKey} />
                </span>
              </Notice>
              {propose.error && <Notice tone="error">{propose.error}</Notice>}
              <button type="button" className="button" disabled={propose.pending} onClick={() => void propose.run()}>
                Revisar y firmar la propuesta
              </button>
            </>
          )}
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
