// `/security/recovery` (P18.T09.a): estado de la clave de recuperación (R leída on-chain del Guard) y su reemplazo si
// se perdió o se comprometió: enrollment de R′ hacia la app Recovery (el mismo flujo de link/QR y confirmación de
// P18.T01), U firma la propuesta armada por la app y, a las 48 h, la ejecución (desde Rotaciones).
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { isAddressEqual } from 'viem';
import { api } from '../../app/services.ts';
import { verifyPrepared, type VerifiedOperation } from '../../chain/safe-tx.ts';
import { systemContracts } from '../../config/index.ts';
import { decodeContext, onchainNonce } from '../../operations/context.ts';
import { OperationReview } from '../../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../../operations/prepared.ts';
import { SETTLED_STATES } from '../../operations/sign.ts';
import { RecoveryActivationStep, type ConfirmedRecovery } from '../../recovery-activation/RecoveryActivationStep.tsx';
import { SafeGate, type OperatingWallet } from '../../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../../session/context.tsx';
import { AddressText } from '../../ui/AddressText.tsx';
import { Notice, useAsyncAction } from '../../ui/forms.tsx';
import { proposeCall } from '../rotations/rotations.ts';

function ReplaceRecovery({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked, state } = ctx;
  const [replacing, setReplacing] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmedRecovery | null>(null);
  const [review, setReview] = useState<VerifiedOperation | null>(null);
  const [proposed, setProposed] = useState(false);

  const propose = useAsyncAction(
    useCallback(async () => {
      if (!confirmed) return;
      await releasePrepared(api, unlocked.platform);
      const { rotation, operation } = await api.proposeRotation(unlocked.platform, wallet.id, 'R');
      setReview(
        await verifiedOrReleased(api, unlocked.platform, [operation], async () => {
          if (!isAddressEqual(rotation.newKey, confirmed.recoveryKey)) {
            throw new Error('La plataforma propone otra dirección de R que la que confirmaste.');
          }
          return verifyPrepared(operation, {
            safe: wallet.safe,
            chainId: 8453,
            onchainNonce: await onchainNonce(reader, wallet.safe),
            build: (n) =>
              proposeCall(
                systemContracts.contracts.timelock.address,
                'R',
                state.roles.recoveryKey,
                confirmed.recoveryKey,
                n,
              ),
          });
        }),
      );
    }, [confirmed, unlocked, wallet, reader, state.roles.recoveryKey]),
  );

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="recovery-status-title">
        <h1 id="recovery-status-title">Tu clave de recuperación (R)</h1>
        <p>
          Dirección de la R vigente en tu Safe (leída del Guard en Base):{' '}
          <AddressText address={state.roles.recoveryKey} />
        </p>
        {!replacing && !proposed && (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setReplacing(true);
            }}
          >
            Reemplazar mi clave de recuperación
          </button>
        )}
      </section>
      {replacing && !confirmed && (
        <RecoveryActivationStep
          walletId={wallet.id}
          platform={unlocked.platform}
          intro="Creá o conectá tu nueva clave R en la app Recovery. El reemplazo se puede ejecutar 48 h después de proponerlo, y hasta entonces lo podés cancelar con U o con tu R actual."
          onConfirmed={setConfirmed}
        />
      )}
      {confirmed && !review && !proposed && (
        <section className="card stack" aria-labelledby="replace-title">
          <h2 id="replace-title">Proponer el reemplazo</h2>
          <p>
            Dirección de tu nueva clave R (confirmada): <AddressText address={confirmed.recoveryKey} />
          </p>
          {propose.error && <Notice tone="error">{propose.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={propose.pending}
            aria-busy={propose.pending}
            onClick={() => void propose.run()}
          >
            Revisar la propuesta
          </button>
        </section>
      )}
      {review && (
        <OperationReview
          title="Revisá la propuesta de reemplazo de tu clave de recuperación"
          items={[review]}
          unlocked={unlocked}
          decode={decodeContext(wallet.safe)}
          onSettled={(statuses) => {
            if (statuses.every((status) => SETTLED_STATES.includes(status.status))) {
              setReview(null);
              setProposed(true);
            }
          }}
          onCancel={() => {
            setReview(null);
          }}
        />
      )}
      {proposed && (
        <Notice tone="success">
          Propuesta enviada: se puede ejecutar dentro de 48 h desde <Link to="/security/rotations">Rotaciones</Link>.
        </Notice>
      )}
    </div>
  );
}

export function ReplaceRecoveryPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <ReplaceRecovery ctx={ctx} />}</SafeGate>;
}
