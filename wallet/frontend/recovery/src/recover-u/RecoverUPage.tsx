// `/recover-u` (P19.T04): reemplazar U perdida por U′. La Wallet registró U′ (con su KeyAcceptance) y dejó la rotación
// en borrador para que R la proponga. Acá: U′ pendiente, que se confirma comparándola con la que muestra la Wallet
// antes de firmar nada (ConfirmNewUserKey: la del backend no se muestra hasta que coincide, [F-LNK-04]); si no
// coincide en los intentos, la app le avisa a la plataforma, que cancela el borrador (REJECTED) y al volver se muestra
// bloqueado. R firma la propuesta que arma la app con la U′ confirmada (R + S, timelock de 48 h), cuenta regresiva con
// la hora de la cadena y, al madurar, R firma la ejecución (swapOwner con el owner anterior leído de la cadena), salvo
// que la propuesta vaya hacia una U′ que no coincidió.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { isAddress, isAddressEqual, type Address } from 'viem';
import { ApiError } from '../api/client.ts';
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
import { currentDraft, REFUSED_PROPOSAL_TEXT, refusedTarget, sameDraft, type UserKeyDraft } from './compare.ts';
import { ConfirmNewUserKey } from './ConfirmNewUserKey.tsx';

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

  const current = currentDraft(rotations);
  const draft = current?.draft ?? null;
  // La U′ confirmada vale sólo para ese mismo borrador y mientras siga sin cancelar: si la Wallet registró otra, hay que
  // volver a comparar.
  const confirmedKey: Address | null =
    confirmed !== null && draft !== null && current?.rejection === null && sameDraft(confirmed, draft)
      ? confirmed.newKey
      : null;
  const live =
    rotations?.find((r) => r.role === 'U' && ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'].includes(r.status)) ?? null;
  // Una propuesta en el timelock hacia una U′ que no coincidió (cancelada o bloqueada en esta pestaña) no se ejecuta.
  const refused = pending !== null && refusedTarget(pending.newValue, rotations);

  const reread = useCallback(async () => {
    const { items } = await api.rotations(walletId);
    setRotations(items);
    const latest = currentDraft(items);
    // Uno que la plataforma ya canceló no se vuelve a comparar: la pantalla lo muestra bloqueado.
    return latest !== null && latest.rejection === null ? latest.draft : null;
  }, [walletId]);

  // Los intentos se agotaron: la plataforma cancela este borrador (con la U′ comparada, para no cancelar otra que la
  // Wallet haya registrado en el mismo borrador mientras tanto).
  const report = useCallback(
    async (target: UserKeyDraft): Promise<boolean> => {
      try {
        const rotation = await api.rejectUserKeyReplacement(platform.auth, target.id, {
          reason: 'MANUAL_COMPARISON_FAILED',
          newKey: target.newKey,
        });
        if (rotation.status === 'REJECTED' && sameDraft({ id: rotation.id, newKey: rotation.newKey }, target)) {
          setRotations((items) => items?.map((r) => (r.id === rotation.id ? rotation : r)) ?? items);
          return true;
        }
      } catch (caught) {
        // 409: la Wallet registró otra U′ en el mismo borrador o ya no es un borrador; se vuelve a leer más abajo.
        if (!(caught instanceof ApiError) || caught.status !== 409) throw caught;
      }
      setReload((n) => n + 1);
      return false;
    },
    [platform.auth],
  );

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
      if (refusedTarget(pending.newValue, rotations)) throw new Error(REFUSED_PROPOSAL_TEXT);
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
    }, [pending, rotations, live, walletId, platform, safe]),
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
          {refused ? (
            <div className="stack" data-u-refused="">
              <Notice tone="error">{REFUSED_PROPOSAL_TEXT}</Notice>
              <p>
                <Link to="/rotations">Ir a Rotaciones</Link>
              </p>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      ) : draft ? (
        <div className="stack" data-draft-u={draft.id}>
          {confirmedKey === null ? (
            <ConfirmNewUserKey
              draft={draft}
              rejection={current?.rejection ?? null}
              reread={reread}
              report={report}
              onConfirmed={setConfirmed}
            />
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
