// `/swap` (P18.T07): USDC↔USDT con la cotización del backend y una propia (QuoterV2 de Uniswap consultado por el RPC del
// frontend), slippage de hasta 0,5 %, review de las dos SafeTx que arma la app (approve exacto + swap, con la allowance
// final en 0), firma de ambas y seguimiento del grupo. La cotización vale sólo para el formulario con el que se pidió:
// cualquier cambio (monto, sentido o slippage) la descarta y hay que volver a cotizar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { erc20Abi } from 'viem';
import type { SwapQuote, TokenSymbol } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { formatAmount, parseAmount } from '../assets/amount.ts';
import { readAssets, type AssetView } from '../assets/assets.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { chainNowSeconds, useChainClock, type ChainClock } from '../chain/ChainNow.tsx';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { tokenAmount } from '../operations/describe.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../operations/prepared.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { formatBps, minOutFor, ownQuote, tokenAddress, verifySwapPair, type SwapReview } from './swap.ts';

const SLIPPAGES = [10, 30, 50] as const;
const DEFAULT_SLIPPAGE_BPS = 30;

interface Quote {
  /** Versión del formulario con la que se cotizó: un cambio posterior la invalida. */
  version: number;
  tokenIn: TokenSymbol;
  amountIn: bigint;
  slippageBps: number;
  backend: SwapQuote;
  own: bigint;
}

const otherToken = (token: TokenSymbol): TokenSymbol => (token === 'USDC' ? 'USDT' : 'USDC');

function Swap({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const swapExecutor = systemContracts.contracts.swapExecutor.address;
  // El deadline del swap lo compara el contrato con block.timestamp: el review lo muestra con las dos horas, leídas al
  // verificar el par y refrescadas cada 30 s (se usa la lectura más reciente).
  const liveClock = useChainClock(reader);
  const [preparedClock, setPreparedClock] = useState<ChainClock | null>(null);
  const clock =
    liveClock !== null && (preparedClock === null || liveClock.deviceMs > preparedClock.deviceMs)
      ? liveClock
      : preparedClock;
  const [tokenIn, setTokenIn] = useState<TokenSymbol>('USDC');
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [review, setReview] = useState<SwapReview | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [reload, setReload] = useState(0);
  const version = useRef(0);

  useEffect(() => {
    const alive = { current: true };
    readAssets(reader, pinnedChain, wallet.safe, null)
      .then((read) => {
        if (alive.current) setAssets(read);
      })
      // Sin el saldo leído el campo no muestra el disponible; la cotización y el backend igual lo validan.
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [reader, wallet.safe, reload]);

  const balance = assets?.find((a) => a.symbol === tokenIn)?.balance ?? null;

  /** Cualquier cambio del formulario descarta la cotización: se prepara siempre lo que se ve. */
  const formChanged = () => {
    version.current += 1;
    setQuote(null);
  };

  const quoteAction = useAsyncAction(
    useCallback(
      async (amountText: string) => {
        const started = version.current;
        const amountIn = parseAmount(amountText, 6);
        if (amountIn <= 0n) throw new Error('El monto tiene que ser mayor que cero.');
        if (balance !== null && amountIn > balance) throw new Error(`No tenés saldo suficiente de ${tokenIn}.`);
        const [backend, own] = await Promise.all([
          api.swapQuote(wallet.id, { tokenIn, amountIn: amountIn.toString(), slippageBps }),
          ownQuote(reader, pinnedChain, tokenIn, amountIn),
        ]);
        if (version.current !== started)
          throw new Error('Cambiaste el formulario mientras se cotizaba: volvé a cotizar.');
        setQuote({ version: started, tokenIn, amountIn, slippageBps, backend, own });
      },
      [wallet.id, reader, tokenIn, slippageBps, balance],
    ),
  );

  const prepare = useAsyncAction(
    useCallback(async () => {
      if (!quote) return;
      if (quote.version !== version.current) {
        throw new Error('La cotización ya no corresponde al formulario: volvé a cotizar.');
      }
      await releasePrepared(api, unlocked.platform);
      const prepared = await api.prepareSwap(unlocked.platform, wallet.id, {
        tokenIn: quote.tokenIn,
        amountIn: quote.amountIn.toString(),
        slippageBps: quote.slippageBps,
      });
      setReview(
        await verifiedOrReleased(api, unlocked.platform, prepared.operations, async () => {
          // La cotización propia se renueva justo antes de verificar el par (el precio pudo moverse).
          const own = await ownQuote(reader, pinnedChain, quote.tokenIn, quote.amountIn);
          const [nonce, chainNow] = await Promise.all([onchainNonce(reader, wallet.safe), chainNowSeconds(reader)]);
          setPreparedClock({ chainMs: Number(chainNow) * 1000, deviceMs: Date.now() });
          return verifySwapPair(prepared, {
            safe: wallet.safe,
            chain: pinnedChain,
            decode: decodeContext(wallet.safe),
            swapExecutor,
            tokenIn: quote.tokenIn,
            amountIn: quote.amountIn,
            slippageBps: quote.slippageBps,
            ownExpectedOut: own,
            onchainNonce: nonce,
            // El deadline lo compara el contrato con block.timestamp.
            nowSeconds: chainNow,
          });
        }),
      );
    }, [quote, unlocked, wallet, reader, swapExecutor]),
  );

  if (review && quote) {
    const out = otherToken(quote.tokenIn);
    return (
      <OperationReview
        title="Revisá el swap"
        doneTitle="Swap realizado"
        items={[review.approve, review.swap]}
        unlocked={unlocked}
        decode={decodeContext(wallet.safe)}
        clock={clock}
        summary={
          <div className="stack">
            <p>
              Son 2 operaciones que se firman juntas: primero un permiso exacto para el contrato de swap de la
              plataforma y después el cambio. Si el precio se mueve más que el slippage que elegiste, el cambio no se
              hace y tus fondos no se mueven.
            </p>
            <dl className="summary" data-swap-summary>
              <dt>Cambiás</dt>
              <dd>{tokenAmount(quote.amountIn, quote.tokenIn)}</dd>
              <dt>Recibirías según la cotización propia</dt>
              <dd data-expected-out={review.ownExpectedOut.toString()}>{tokenAmount(review.ownExpectedOut, out)}</dd>
              <dt>Diferencia de precio máxima (slippage)</dt>
              <dd data-slippage-bps={quote.slippageBps}>{formatBps(quote.slippageBps)}</dd>
              <dt>Recibís como mínimo</dt>
              <dd>{tokenAmount(review.minAmountOut, out)}</dd>
            </dl>
          </div>
        }
        onCancel={() => {
          setReview(null);
        }}
        onSettled={() => {
          void reader
            .readContract({
              address: tokenAddress(pinnedChain, quote.tokenIn),
              abi: erc20Abi,
              functionName: 'allowance',
              args: [wallet.safe, swapExecutor],
            })
            .then(setAllowance);
        }}
        result={
          allowance !== null && (
            <p role="status" data-allowance={allowance.toString()}>
              Permiso que le quedó al contrato de swap de la plataforma sobre tus {quote.tokenIn}:{' '}
              {formatAmount(allowance, 6)} {quote.tokenIn}
              {allowance === 0n ? ' (como tiene que quedar).' : ': no volvió a 0; revisá el swap en Actividad.'}
            </p>
          )
        }
        doneActions={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                version.current += 1;
                setReview(null);
                setQuote(null);
                setAllowance(null);
                setReload((n) => n + 1);
              }}
            >
              Hacer otro swap
            </button>
            <Link className="button button--ghost" to="/activity">
              Ver la actividad
            </Link>
          </>
        }
      />
    );
  }

  const out = otherToken(tokenIn);
  return (
    <section className="card stack" aria-labelledby="swap-title">
      <h1 id="swap-title">Swap USDC ↔ USDT</h1>
      <form
        className="stack"
        onChange={formChanged}
        onSubmit={(event) => {
          event.preventDefault();
          void quoteAction.run(formValue(event.currentTarget, 'amount'));
        }}
      >
        <fieldset className="choices">
          <legend>Cambiar</legend>
          {(['USDC', 'USDT'] as const).map((token) => (
            <label key={token} className="check">
              <input
                type="radio"
                name="tokenIn"
                value={token}
                checked={tokenIn === token}
                onChange={() => {
                  setTokenIn(token);
                }}
              />{' '}
              {token} por {otherToken(token)}
            </label>
          ))}
        </fieldset>
        <Field
          label={`Monto a cambiar (${tokenIn})`}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          required
          hint={balance === null ? undefined : `Disponible: ${formatAmount(balance, 6)} ${tokenIn}`}
        />
        <div className="field">
          <fieldset className="choices" aria-describedby="slippage-hint">
            <legend>Diferencia de precio máxima que aceptás (slippage)</legend>
            {SLIPPAGES.map((bps) => (
              <label key={bps} className="check">
                <input
                  type="radio"
                  name="slippage"
                  value={bps}
                  checked={slippageBps === bps}
                  onChange={() => {
                    setSlippageBps(bps);
                  }}
                />{' '}
                {formatBps(bps)}
              </label>
            ))}
          </fieldset>
          <p id="slippage-hint" className="field__hint">
            Si al ejecutarse el precio es peor que la cotización por más que esto, el swap no se hace y tus fondos no se
            mueven. El máximo es 0,5 %.
          </p>
        </div>
        {quoteAction.error && <Notice tone="error">{quoteAction.error}</Notice>}
        <button
          type="submit"
          className="button button--secondary"
          disabled={quoteAction.pending}
          aria-busy={quoteAction.pending}
        >
          Cotizar
        </button>
      </form>
      {quote && (
        <div className="stack" data-quote>
          <dl className="summary">
            <dt>Cambiás</dt>
            <dd>{tokenAmount(quote.amountIn, quote.tokenIn)}</dd>
            <dt>Cotización de la plataforma</dt>
            <dd data-backend-out={quote.backend.expectedOut}>{tokenAmount(BigInt(quote.backend.expectedOut), out)}</dd>
            <dt>Cotización propia</dt>
            <dd data-own-out={quote.own.toString()}>{tokenAmount(quote.own, out)}</dd>
            <dt>Mínimo a recibir con {formatBps(quote.slippageBps)}</dt>
            <dd data-min-out={minOutFor(quote.own, quote.slippageBps).toString()}>
              {tokenAmount(minOutFor(quote.own, quote.slippageBps), out)}
            </dd>
          </dl>
          <p className="field__hint">
            La cotización propia la calcula esta app preguntándole directamente al pool de Uniswap en Base (contrato
            QuoterV2), sin pasar por la plataforma: si las dos coinciden, la de la plataforma no está adulterada.
          </p>
          {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={prepare.pending}
            aria-busy={prepare.pending}
            onClick={() => void prepare.run()}
          >
            {prepare.pending ? 'Preparando…' : 'Preparar el swap'}
          </button>
        </div>
      )}
    </section>
  );
}

export function SwapPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Swap ctx={ctx} />}</SafeGate>;
}
