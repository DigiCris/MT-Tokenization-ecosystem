// `/assets` (P18.T04): USDC y USDT con saldo, símbolo, decimales y contrato, leídos on-chain y comparados con la config
// fijada (si difieren, error bloqueante).
import { useEffect, useState } from 'react';
import { api } from '../app/services.ts';
import { pinnedChain } from '../config/chain.ts';
import { explorerAddress } from '../activity/activity.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Notice } from '../ui/forms.tsx';
import { formatAmount } from './amount.ts';
import { readAssets, type AssetView } from './assets.ts';

function Assets({ ctx }: { ctx: OperatingWallet }) {
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      const backend = await api.balances(ctx.wallet.id).catch(() => null);
      try {
        const read = await readAssets(ctx.reader, pinnedChain, ctx.wallet.safe, backend);
        if (alive.current) setAssets(read);
      } catch (caught) {
        if (alive.current) setError(describeError(caught));
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [ctx]);
  return (
    <section className="card stack" aria-labelledby="assets-title">
      <h1 id="assets-title">Activos</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {!assets && !error && <p className="muted">Leyendo los tokens en Base…</p>}
      {assets?.map((a) => (
        <article key={a.symbol} className="asset stack" data-token={a.symbol}>
          <h2>{a.symbol}</h2>
          <dl className="summary">
            <dt>Saldo</dt>
            <dd data-balance={a.balance.toString()}>
              {formatAmount(a.balance, a.decimals)} {a.symbol}
            </dd>
            <dt>Decimales (on-chain = fijados)</dt>
            <dd>{a.decimals}</dd>
            <dt>Contrato</dt>
            <dd>
              <AddressText address={a.address} />{' '}
              <a href={explorerAddress(pinnedChain, a.address)} target="_blank" rel="noopener noreferrer">
                ver en el explorer
              </a>
            </dd>
          </dl>
          {a.backendMismatch && (
            <Notice tone="warning">
              La plataforma informa otro saldo ({formatAmount(a.backendBalance ?? 0n, a.decimals)}): manda el de la
              cadena.
            </Notice>
          )}
        </article>
      ))}
    </section>
  );
}

export function AssetsPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Assets ctx={ctx} />}</SafeGate>;
}
