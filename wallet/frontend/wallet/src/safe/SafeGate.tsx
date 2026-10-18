// La operación de la Safe (P18) pasa por acá: cuenta con wallet ACTIVE, desbloqueada y con la verificación propia por el
// RPC del frontend en orden (V9 §16; una vez por desbloqueo). Si algún ítem falla, la app no opera con esa Safe.
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { Address } from 'viem';
import type { WalletView } from '../api/wallet-api.ts';
import { chainReader } from '../app/services.ts';
import type { BaseClient } from '../chain/client.ts';
import { useSession } from '../session/context.tsx';
import { Notice } from '../ui/forms.tsx';
import { describeError } from '../ui/errors.ts';
import type { UnlockedWallet } from '../unlock/unlock.ts';
import { failureText, verifyOnUnlock } from './gate.ts';
import type { SafeState } from './verify.ts';

export interface OperatingWallet {
  wallet: WalletView & { safe: Address };
  unlocked: UnlockedWallet;
  reader: BaseClient;
  state: SafeState;
}

type Check =
  { status: 'pending' } | { status: 'ok'; state: SafeState } | { status: 'failed'; message: string; items: string[] };

export function SafeGate({ children }: { children: (ctx: OperatingWallet) => ReactNode }) {
  const { wallet, unlocked } = useSession();
  const location = useLocation();
  const [check, setCheck] = useState<{ sessionId: string; result: Check } | null>(null);
  const safe = wallet?.status === 'ACTIVE' ? wallet.safe : null;
  const sessionId = unlocked?.platform.sessionId ?? null;

  useEffect(() => {
    if (safe === null || unlocked === null || sessionId === null) return;
    let live = true;
    verifyOnUnlock(sessionId, chainReader, { safe, userKey: unlocked.envelope.keyAddress })
      .then((result) => {
        if (!live) return;
        setCheck({
          sessionId,
          result: result.ok
            ? { status: 'ok', state: result.state }
            : { status: 'failed', message: 'La verificación propia de tu Safe falló.', items: result.failures },
        });
      })
      .catch((error: unknown) => {
        if (live) setCheck({ sessionId, result: { status: 'failed', message: describeError(error), items: [] } });
      });
    return () => {
      live = false;
    };
  }, [safe, unlocked, sessionId]);

  if (!wallet) {
    return (
      <Notice>
        Todavía no creaste tu wallet. <Link to="/onboarding">Crearla</Link>
      </Notice>
    );
  }
  if (wallet.status === 'CREATING') {
    return (
      <Notice>
        Falta terminar la creación de tu wallet. <Link to="/onboarding">Seguir</Link>
      </Notice>
    );
  }
  if (wallet.status !== 'ACTIVE' || wallet.safe === null) {
    return <Notice tone="warning">Tu wallet no está activa ({wallet.status}).</Notice>;
  }
  if (!unlocked) {
    return (
      <Notice>
        Desbloqueá tu wallet para operar.{' '}
        <Link to={`/unlock?returnTo=${encodeURIComponent(location.pathname)}`}>Desbloquear</Link>
      </Notice>
    );
  }
  const result = check?.sessionId === sessionId ? check.result : { status: 'pending' as const };
  if (result.status === 'pending') return <Notice>Verificando tu Safe en Base…</Notice>;
  if (result.status === 'failed') {
    return (
      <Notice tone="error">
        <strong>{result.message}</strong> La app no opera con esta Safe.
        {result.items.length > 0 && (
          <ul className="failures">
            {result.items.map((item) => (
              <li key={item} data-item={item}>
                {failureText(item)}
              </li>
            ))}
          </ul>
        )}
      </Notice>
    );
  }
  return (
    <>{children({ wallet: { ...wallet, safe: wallet.safe }, unlocked, reader: chainReader, state: result.state })}</>
  );
}
