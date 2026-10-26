// `/security/recovery` (P18.T09.a): estado de la clave de recuperación (R leída on-chain del Guard) y su reemplazo si
// se perdió o se comprometió: enrollment de R′ hacia la app Recovery (el mismo flujo de link/QR y confirmación de
// P18.T01), U firma la propuesta armada por la app y, a las 48 h, la ejecución (desde Rotaciones). El paso de
// activación sabe que es un reemplazo por esta pantalla, no por lo que diga el pedido (cuarta revisión de P17.MAN).
//
// Verificación de P17.MAN (N14): crear R′ en Recovery puede llevar más de los 5 minutos de inactividad que bloquean la
// wallet. Como en el onboarding, el paso de activación queda montado aunque la wallet se bloquee (fuera de SafeGate): el
// pedido vigente y su secreto `k` siguen en la memoria de esta pestaña, Recovery lo sigue pudiendo usar y la dirección
// se confirma igual (con la sesión de cuenta). Bloqueada, la pantalla ofrece desbloquear ahí mismo (ir a /unlock la
// desmontaría y el pedido se perdería) y, al desbloquear, sigue con la sesión nueva: otro pedido o la propuesta.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { isAddressEqual, type Address } from 'viem';
import type { PlatformAuth } from '../../api/request-signature.ts';
import { api } from '../../app/services.ts';
import { verifyPrepared, type VerifiedOperation } from '../../chain/safe-tx.ts';
import { systemContracts } from '../../config/index.ts';
import { decodeContext, onchainNonce } from '../../operations/context.ts';
import { OperationReview } from '../../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../../operations/prepared.ts';
import { SETTLED_STATES } from '../../operations/sign.ts';
import {
  LOCKED_AFTER_CONFIRMATION_TEXT,
  LOCKED_DURING_REPLACEMENT_TEXT,
} from '../../recovery-activation/activation.ts';
import { RecoveryActivationStep, type ConfirmedRecovery } from '../../recovery-activation/RecoveryActivationStep.tsx';
import { SafeGate, type OperatingWallet } from '../../safe/SafeGate.tsx';
import { useSensitiveScreen, useSession } from '../../session/context.tsx';
import { liveUntil } from '../../session/step-up.ts';
import { AddressText } from '../../ui/AddressText.tsx';
import { Notice, useAsyncAction } from '../../ui/forms.tsx';
import { UnlockForm } from '../../unlock/UnlockForm.tsx';
import { proposeCall } from '../rotations/rotations.ts';

/** El reemplazo empezado: la wallet, la R vigente leída del Guard y la sesión con la que se pidió. */
interface Replacement {
  walletId: string;
  currentRecoveryKey: Address;
  platform: PlatformAuth;
}

/** Sin la wallet desbloqueada no hay sesión para otro pedido: el paso espera el desbloqueo. */
const NO_SESSION = new Date(0).toISOString();

/**
 * Mientras el paso espera una sesión para otro pedido: con la wallet desbloqueada de nuevo, sigue solo (una vez por
 * sesión, aunque el efecto corra de nuevo).
 */
function RenewOnUnlock({ renewed }: { renewed: (platform: PlatformAuth) => void }) {
  const { unlocked } = useSession();
  const renewedWith = useRef<string | null>(null);
  useEffect(() => {
    if (unlocked === null || !liveUntil(unlocked.session.expiresAt)) return;
    if (renewedWith.current === unlocked.session.id) return;
    renewedWith.current = unlocked.session.id;
    renewed(unlocked.platform);
  }, [unlocked, renewed]);
  return null;
}

function ReplaceRecovery({
  ctx,
  started,
  onStart,
  confirmed,
  proposed,
  onProposed,
}: {
  ctx: OperatingWallet;
  started: boolean;
  onStart: () => void;
  confirmed: ConfirmedRecovery | null;
  /** La propuesta ya salió (lo sabe la pantalla, no este paso: sobrevive a un bloqueo). */
  proposed: boolean;
  onProposed: () => void;
}) {
  const { wallet, reader, unlocked, state } = ctx;
  const [review, setReview] = useState<VerifiedOperation | null>(null);

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
        {!started && !proposed && (
          <button type="button" className="button button--secondary" onClick={onStart}>
            Reemplazar mi clave de recuperación
          </button>
        )}
      </section>
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
              onProposed();
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
  const { unlocked } = useSession();
  const [replacement, setReplacement] = useState<Replacement | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedRecovery | null>(null);
  const [proposed, setProposed] = useState(false);
  const renewSession = useCallback(
    (renewed: (platform: PlatformAuth) => void) => <RenewOnUnlock renewed={renewed} />,
    [],
  );
  // Con un reemplazo en curso (pedido sin confirmar o R′ confirmada sin proponer), un bloqueo no saca de la pantalla.
  const inProgress = replacement !== null && !proposed;

  return (
    <div className="stack">
      {inProgress && unlocked === null ? (
        <section className="stack" aria-labelledby="replace-locked-title" data-replacement-locked="">
          <article className="card stack">
            <h1 id="replace-locked-title">La wallet se bloqueó</h1>
            <Notice tone="warning">
              {confirmed === null ? LOCKED_DURING_REPLACEMENT_TEXT : LOCKED_AFTER_CONFIRMATION_TEXT}
            </Notice>
          </article>
          <UnlockForm inPlace />
        </section>
      ) : (
        <SafeGate>
          {(ctx) => (
            <ReplaceRecovery
              ctx={ctx}
              started={replacement !== null}
              confirmed={confirmed}
              proposed={proposed}
              onProposed={() => {
                setProposed(true);
              }}
              onStart={() => {
                setReplacement({
                  walletId: ctx.wallet.id,
                  currentRecoveryKey: ctx.state.roles.recoveryKey,
                  platform: ctx.unlocked.platform,
                });
              }}
            />
          )}
        </SafeGate>
      )}
      {replacement !== null && confirmed === null && (
        <RecoveryActivationStep
          walletId={replacement.walletId}
          // Con la wallet bloqueada, la última sesión (revocada): el próximo pedido espera el desbloqueo (renewSession).
          platform={unlocked?.platform ?? replacement.platform}
          sessionExpiresAt={unlocked?.session.expiresAt ?? NO_SESSION}
          purpose="REPLACEMENT"
          currentRecoveryKey={replacement.currentRecoveryKey}
          intro="Creá o conectá tu nueva clave R en la app Recovery. El reemplazo se puede ejecutar 48 h después de proponerlo, y hasta entonces lo podés cancelar con U o con tu R actual."
          renewSession={renewSession}
          onConfirmed={setConfirmed}
        />
      )}
    </div>
  );
}
