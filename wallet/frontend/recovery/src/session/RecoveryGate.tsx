// Antes de operar con R (recuperar U, rotaciones, emergencia, migración): la cuenta, el firmante R (sobre desbloqueado
// o wallet externa), la PlatformSession RECOVERY de esa wallet (step-up) y la verificación propia de la Safe por el RPC
// de Recovery —contratos con su codehash, Safe v1.5.0, Guard y module guard del sistema, owners = roles y R como
// recoveryKey del Guard—. Si algo no coincide, no se opera.
//
// Cuarta revisión de P17.MAN (hallazgo 12): si la R desbloqueada no es firmante de la Safe (un sobre recordado de un
// pedido anterior), se dice y se ofrece olvidar ese sobre en este dispositivo o elegir otro, sin perder la verificación;
// nunca olvidar el de R′ de un reemplazo en curso en Base. El desbloqueo ofrece también el camino de las 17 palabras.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isAddressEqual, type Address } from 'viem';
import { pinned, reader } from '../app/services.ts';
import { LoginForm } from '../auth/LoginForm.tsx';
import { pendingProposals, type PendingProposal } from '../chain/rotations.ts';
import { checkSafe, notASigner, safeFailureText, type CheckedSafe } from '../chain/safe-check.ts';
import { ConnectExternal } from '../enroll/ConnectExternal.tsx';
import { forgetRememberedEnvelope, isRememberedEnvelope, rememberSafe } from '../storage/envelope-cache.ts';
import { currentSigner, type PlatformSession } from './store.ts';
import type { RecoverySigner } from '../signer/recovery-signer.ts';
import { UnlockRecovery } from '../unlock/UnlockRecovery.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { useSession, useSessionStore } from './context.tsx';
import { StepUp } from './StepUp.tsx';
import { notASignerText, pendingReplacementText } from './texts.ts';

export interface RecoveryContext {
  platform: PlatformSession;
  signer: RecoverySigner;
  walletId: string;
  safe: Address;
  checked: CheckedSafe;
}

/** Una R interna que no es firmante de la Safe: si el dispositivo recuerda su sobre y si es R′ de un reemplazo en curso. */
interface Stranger {
  remembered: boolean;
  replacement: PendingProposal | null;
}

async function strangerOf(signer: RecoverySigner, safe: Address): Promise<Stranger | null> {
  if (signer.kind !== 'internal' || signer.walletId === null) return null;
  const [remembered, proposals] = await Promise.all([
    isRememberedEnvelope(signer.walletId, signer.address).catch(() => false),
    pendingProposals(reader, pinned.system.contracts.timelock.address, safe).catch(() => [] as PendingProposal[]),
  ]);
  const replacement = proposals.find((p) => p.kind === 'R' && isAddressEqual(p.newValue, signer.address)) ?? null;
  return { remembered, replacement };
}

export function RecoveryGate({ children }: { children: (ctx: RecoveryContext) => ReactNode }) {
  const session = useSession();
  const store = useSessionStore();
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [checked, setChecked] = useState<{
    key: string;
    result: CheckedSafe | null;
    error: string | null;
    stranger: Stranger | null;
  } | null>(null);
  // Estable mientras no cambie la R desbloqueada o la wallet conectada (la verificación depende de él).
  const { recovery, external } = session;
  const signer = useMemo(() => currentSigner({ recovery, external }), [recovery, external]);
  const platform = session.platform;
  const walletMatches =
    platform !== null &&
    platform.view.scope === 'RECOVERY' &&
    platform.view.walletId !== null &&
    (signer === null || signer.walletId === null || signer.walletId === platform.view.walletId);
  const safe = walletMatches ? platform.view.safe : null;
  const checkKey = safe !== null && signer !== null ? `${safe}:${signer.address}` : null;

  useEffect(() => {
    if (checkKey === null || safe === null || signer === null) return;
    let alive = true;
    checkSafe(reader, pinned, safe, { recoveryKey: signer.address })
      .then(async (result) => {
        // Para el modo soberano: la Safe de esta R, sin depender del backend.
        if (result.failures.length === 0) void rememberSafe(signer.address, result.safe).catch(() => undefined);
        const stranger = notASigner(result, signer.address) ? await strangerOf(signer, safe) : null;
        if (alive) setChecked({ key: checkKey, result, error: null, stranger });
      })
      .catch((error: unknown) => {
        if (alive) setChecked({ key: checkKey, result: null, error: describeError(error), stranger: null });
      });
    return () => {
      alive = false;
    };
  }, [checkKey, safe, signer]);

  // Olvidar el sobre de una R que no es firmante (sólo ése) y volver a elegir, con la misma verificación.
  const forget = useAsyncAction(
    useCallback(
      async (walletId: string, recoveryKey: Address) => {
        await forgetRememberedEnvelope(walletId, recoveryKey);
        store.discardKey();
      },
      [store],
    ),
  );

  if (session.status === 'loading') return <p className="muted">Cargando…</p>;
  if (session.status !== 'account') {
    return (
      <section className="card stack narrow" aria-labelledby="gate-login-title">
        <h1 id="gate-login-title">Iniciá sesión</h1>
        <p>Usá la misma cuenta que en la app Wallet.</p>
        <LoginForm onSignedIn={() => undefined} />
      </section>
    );
  }
  if (signer === null) {
    return (
      <div className="stack">
        {session.lockReason === 'INACTIVITY' && (
          <Notice tone="warning">Se bloqueó por inactividad: desbloqueá R de nuevo.</Notice>
        )}
        <div className="actions">
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={mode === 'internal'}
            onClick={() => {
              setMode('internal');
            }}
          >
            Mi clave R está en este navegador o en un archivo
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={mode === 'external'}
            onClick={() => {
              setMode('external');
            }}
          >
            Mi clave R es una wallet externa
          </button>
        </div>
        {mode === 'internal' ? (
          <UnlockRecovery wordsHint />
        ) : (
          <ConnectExternal
            onConnected={(external) => {
              store.connectExternal(external);
            }}
          />
        )}
      </div>
    );
  }
  if (!walletMatches) {
    return <StepUp scope="RECOVERY" {...(signer.walletId === null ? {} : { walletId: signer.walletId })} />;
  }
  if (safe === null || platform.view.walletId === null) {
    return <Notice tone="error">La wallet todavía no tiene una Safe activa.</Notice>;
  }
  if (checked === null || checked.key !== checkKey) return <p className="muted">Verificando tu Safe en Base…</p>;
  if (checked.error !== null) return <Notice tone="error">{checked.error}</Notice>;
  if (checked.result === null || checked.result.failures.length > 0) {
    const { stranger } = checked;
    const walletId = signer.walletId;
    return (
      <div className="stack">
        <Notice tone="error">
          <p>La verificación propia de tu Safe falló: no se opera con ella.</p>
          <ul>
            {checked.result?.failures.map((item) => (
              <li key={item} data-item={item}>
                {safeFailureText(item)}
              </li>
            ))}
          </ul>
        </Notice>
        {stranger !== null && walletId !== null && (
          <section className="card stack" aria-labelledby="not-a-signer-title" data-not-a-signer={signer.address}>
            <h2 id="not-a-signer-title">Esta clave R no es firmante de tu Safe</h2>
            <p>
              Dirección de la clave R que desbloqueaste: <AddressText address={signer.address} />
            </p>
            <p>
              {stranger.replacement !== null
                ? pendingReplacementText(stranger.replacement.executableAt)
                : notASignerText(stranger.remembered)}
            </p>
            {forget.error && <Notice tone="error">{forget.error}</Notice>}
            <div className="actions">
              {stranger.remembered && stranger.replacement === null && (
                <button
                  type="button"
                  className="button"
                  disabled={forget.pending}
                  onClick={() => void forget.run(walletId, signer.address)}
                >
                  Olvidar este sobre
                </button>
              )}
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  store.discardKey();
                }}
              >
                Usar otro sobre
              </button>
            </div>
          </section>
        )}
      </div>
    );
  }
  return children({ platform, signer, walletId: platform.view.walletId, safe, checked: checked.result });
}
