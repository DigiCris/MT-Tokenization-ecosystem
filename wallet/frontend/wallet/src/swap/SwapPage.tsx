// `/swap` (P18.T07): USDC↔USDT con la cotización del backend y una propia (QuoterV2 por el RPC del frontend), slippage
// de hasta 0,5 %, review de las dos SafeTx que arma la app (approve exacto + swap, con la allowance final en 0), firma de
// ambas y seguimiento del grupo.
import { useCallback, useState } from 'react';
import type { SwapQuote, TokenSymbol } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { erc20Abi } from 'viem';
import { formatAmount, parseAmount } from '../assets/amount.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { chainNowSeconds } from '../chain/ChainNow.tsx';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../operations/prepared.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { minOutFor, ownQuote, tokenAddress, verifySwapPair, type SwapReview } from './swap.ts';

const SLIPPAGES = [10, 30, 50] as const;

function Swap({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const swapExecutor = systemContracts.contracts.swapExecutor.address;
  const [quote, setQuote] = useState<{
    tokenIn: TokenSymbol;
    amountIn: bigint;
    slippageBps: number;
    backend: SwapQuote;
    own: bigint;
  } | null>(null);
  const [review, setReview] = useState<SwapReview | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const quoteAction = useAsyncAction(
    useCallback(
      async (tokenIn: TokenSymbol, amountText: string, slippageBps: number) => {
        const amountIn = parseAmount(amountText, 6);
        if (amountIn <= 0n) throw new Error('El monto tiene que ser mayor que cero.');
        const [backend, own] = await Promise.all([
          api.swapQuote(wallet.id, { tokenIn, amountIn: amountIn.toString(), slippageBps }),
          ownQuote(reader, pinnedChain, tokenIn, amountIn),
        ]);
        setQuote({ tokenIn, amountIn, slippageBps, backend, own });
      },
      [wallet.id, reader],
    ),
  );

  const prepare = useAsyncAction(
    useCallback(async () => {
      if (!quote) return;
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
    return (
      <div className="stack">
        <OperationReview
          title="Revisá el swap (dos operaciones)"
          items={[review.approve, review.swap]}
          unlocked={unlocked}
          decode={decodeContext(wallet.safe)}
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
        />
        {allowance !== null && (
          <p role="status" data-allowance={allowance.toString()}>
            Permiso restante del SwapExecutor sobre {quote.tokenIn}: {formatAmount(allowance, 6)}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="card stack" aria-labelledby="swap-title">
      <h1 id="swap-title">Swap USDC ↔ USDT</h1>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          void quoteAction.run(
            formValue(form, 'tokenIn') as TokenSymbol,
            formValue(form, 'amount'),
            Number(formValue(form, 'slippage')),
          );
        }}
      >
        <fieldset className="choices">
          <legend>Cambiar</legend>
          <label className="check">
            <input type="radio" name="tokenIn" value="USDC" defaultChecked /> USDC por USDT
          </label>
          <label className="check">
            <input type="radio" name="tokenIn" value="USDT" /> USDT por USDC
          </label>
        </fieldset>
        <Field label="Monto" name="amount" inputMode="decimal" autoComplete="off" placeholder="0,00" required />
        <fieldset className="choices">
          <legend>Slippage máximo</legend>
          {SLIPPAGES.map((bps) => (
            <label key={bps} className="check">
              <input type="radio" name="slippage" value={bps} defaultChecked={bps === 30} /> {(bps / 100).toFixed(1)} %
            </label>
          ))}
        </fieldset>
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
            <dt>Cotización de la plataforma</dt>
            <dd data-backend-out={quote.backend.expectedOut}>
              {formatAmount(BigInt(quote.backend.expectedOut), 6)} {quote.tokenIn === 'USDC' ? 'USDT' : 'USDC'}
            </dd>
            <dt>Cotización propia (QuoterV2 por tu RPC)</dt>
            <dd data-own-out={quote.own.toString()}>
              {formatAmount(quote.own, 6)} {quote.tokenIn === 'USDC' ? 'USDT' : 'USDC'}
            </dd>
            <dt>Mínimo a recibir con {(quote.slippageBps / 100).toFixed(1)} %</dt>
            <dd>{formatAmount(minOutFor(quote.own, quote.slippageBps), 6)}</dd>
          </dl>
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
