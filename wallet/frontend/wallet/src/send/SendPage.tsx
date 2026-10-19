// `/send` (P18.T06): token → destino (sólo los activos on-chain de la whitelist) → monto (bigint con los decimales
// fijados; debajo del campo, cómo se interpreta lo escrito) → review decodificado desde la SafeTx que arma la app,
// comparada byte a byte con la del backend (si difieren, no se firma) → segundo factor si corresponde → firma de U →
// seguimiento. Los nombres de los destinos son los labels del usuario, entre «».
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Address } from 'viem';
import type { TokenSymbol } from '../api/wallet-api.ts';
import { api } from '../app/services.ts';
import { verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { formatAmount, parseAmount, readAmount } from '../assets/amount.ts';
import { readAssets, type AssetView } from '../assets/assets.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { labelsOf, userLabel } from '../operations/names.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, verifiedOrReleased } from '../operations/prepared.ts';
import { SafeGate, type OperatingWallet } from '../safe/SafeGate.tsx';
import { useSensitiveScreen } from '../session/context.tsx';
import { AddressText, groupAddress } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { isActiveDestination, readWhitelist, type Destination } from '../whitelist/whitelist.ts';
import { transferCall } from './send.ts';

function Send({ ctx }: { ctx: OperatingWallet }) {
  const { wallet, reader, unlocked } = ctx;
  const whitelistAddress = systemContracts.contracts.whitelist.address;
  const [assets, setAssets] = useState<AssetView[] | null>(null);
  const [active, setActive] = useState<Destination[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<VerifiedOperation | null>(null);
  const [tokenChoice, setTokenChoice] = useState<TokenSymbol | null>(null);
  const [chosen, setChosen] = useState<Address | null>(null);
  const [amountText, setAmountText] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const alive = { current: true };
    void (async () => {
      try {
        const [read, labels] = await Promise.all([
          readAssets(reader, pinnedChain, wallet.safe, null),
          api.whitelist(wallet.id).catch(() => ({ entries: [] })),
        ]);
        const destinations = await readWhitelist(reader, whitelistAddress, wallet.safe, labels);
        if (!alive.current) return;
        setAssets(read);
        // Sólo los destinos activos on-chain se pueden elegir.
        setActive(destinations.filter((d) => d.active));
      } catch (caught) {
        if (alive.current) setError(describeError(caught));
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [wallet, reader, whitelistAddress, reload]);

  const prepare = useAsyncAction(
    useCallback(
      async (token: TokenSymbol, destination: Address, amountText: string) => {
        const pinned = token === 'USDC' ? pinnedChain.tokens.usdc : pinnedChain.tokens.usdt;
        const amount = parseAmount(amountText, pinned.decimals);
        if (amount <= 0n) throw new Error('El monto tiene que ser mayor que cero.');
        const balance = assets?.find((a) => a.symbol === token)?.balance ?? 0n;
        if (amount > balance) throw new Error(`No tenés saldo suficiente de ${token}.`);
        if (!(await isActiveDestination(reader, whitelistAddress, wallet.safe, destination))) {
          throw new Error('Ese destino todavía no está activo en tu whitelist (en Base).');
        }
        // Lo preparado y abandonado antes en esta pestaña libera su nonce antes de reservar uno nuevo.
        await releasePrepared(api, unlocked.platform);
        const prepared = await api.prepareSend(unlocked.platform, wallet.id, {
          token,
          destination,
          amount: amount.toString(),
        });
        setReview(
          await verifiedOrReleased(api, unlocked.platform, [prepared], async () =>
            verifyPrepared(prepared, {
              safe: wallet.safe,
              chainId: 8453,
              onchainNonce: await onchainNonce(reader, wallet.safe),
              build: (n) => transferCall(pinned, destination, amount, n),
            }),
          ),
        );
      },
      [assets, reader, whitelistAddress, wallet, unlocked],
    ),
  );

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!assets || !active) return <p className="muted">Leyendo saldos y whitelist en Base…</p>;
  if (review) {
    return (
      <OperationReview
        title="Revisá el envío"
        doneTitle="Envío realizado"
        items={[review]}
        unlocked={unlocked}
        decode={decodeContext(wallet.safe)}
        labels={labelsOf(active)}
        onCancel={() => {
          setReview(null);
        }}
        doneActions={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setReview(null);
                setAmountText('');
                setReload((n) => n + 1);
              }}
            >
              Hacer otro envío
            </button>
            <Link className="button button--ghost" to="/activity">
              Ver la actividad
            </Link>
          </>
        }
      />
    );
  }
  const selectedToken = tokenChoice ?? assets[0]?.symbol ?? 'USDC';
  const selectedAsset = assets.find((a) => a.symbol === selectedToken);
  const reading = readAmount(amountText, selectedAsset?.decimals ?? 6);
  const destination = active.find((d) => d.address === chosen) ?? active[0];
  return (
    <section className="card stack" aria-labelledby="send-title">
      <h1 id="send-title">Enviar</h1>
      {active.length === 0 || !destination ? (
        <Notice>
          No tenés destinos activos: agregá uno a tu <Link to="/whitelist">whitelist</Link> (se activa 24 h después).
        </Notice>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            void prepare.run(
              formValue(form, 'token') as TokenSymbol,
              formValue(form, 'destination') as Address,
              formValue(form, 'amount'),
            );
          }}
        >
          <fieldset className="choices">
            <legend>Token</legend>
            {assets.map((a) => (
              <label key={a.symbol} className="check">
                <input
                  type="radio"
                  name="token"
                  value={a.symbol}
                  checked={a.symbol === selectedToken}
                  onChange={() => {
                    setTokenChoice(a.symbol);
                  }}
                />{' '}
                {a.symbol} (saldo {formatAmount(a.balance, a.decimals)})
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="send-destination" className="field__label">
              Destino (sólo los activos de tu whitelist)
            </label>
            <select
              id="send-destination"
              name="destination"
              className="field__input"
              required
              value={destination.address}
              aria-describedby="send-destination-hint"
              onChange={(event) => {
                setChosen(event.currentTarget.value as Address);
              }}
            >
              {active.map((d) => (
                <option key={d.address} value={d.address}>
                  {d.label === null ? 'Sin nombre' : userLabel(d.label)} — {groupAddress(d.address)}
                </option>
              ))}
            </select>
            <p id="send-destination-hint" className="field__hint">
              Dirección completa: <AddressText address={destination.address} />. ¿Falta un destino? Agregalo en la{' '}
              <Link to="/whitelist">whitelist</Link>: se activa 24 h después.
            </p>
          </div>
          <Field
            label={`Monto (${selectedToken})`}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            required
            defaultValue={amountText}
            onChange={(event) => {
              setAmountText(event.currentTarget.value);
            }}
            hint={
              !selectedAsset && reading === null ? undefined : (
                <>
                  {selectedAsset &&
                    `Disponible: ${formatAmount(selectedAsset.balance, selectedAsset.decimals)} ${selectedToken}.`}
                  {reading && (
                    <span data-amount-reading={reading.ok ? reading.units.toString() : 'invalid'}>
                      {selectedAsset && ' '}
                      {reading.ok ? `Vas a enviar ${reading.text} ${selectedToken}.` : reading.message}
                    </span>
                  )}
                </>
              )
            }
          />
          {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
          <button type="submit" className="button" disabled={prepare.pending} aria-busy={prepare.pending}>
            {prepare.pending ? 'Preparando…' : 'Revisar el envío'}
          </button>
        </form>
      )}
    </section>
  );
}

export function SendPage() {
  useSensitiveScreen();
  return <SafeGate>{(ctx) => <Send ctx={ctx} />}</SafeGate>;
}
