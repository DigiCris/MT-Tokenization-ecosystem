// `/security/migration` (P18.T11): migración excepcional. La wallet vieja (MIGRATING) sale de la notificación
// MIGRATION_APPROVED; se desbloquea con su sobre de U (OPAQUE de esa wallet), la plataforma prepara un MIGRATION_TRANSFER
// por token con saldo y, antes de que U firme, la app verifica on-chain la Safe destino (creada por la factory,
// registrada en el Guard con la misma U, owners = roles y autorización activa en el PolicyRegistry) y arma ella misma
// cada transfer del saldo completo leído de la cadena hacia la Safe nueva.
import { useCallback, useEffect, useState } from 'react';
import { isAddressEqual } from 'viem';
import type { AppNotification, MigrationPreparation } from '../api/wallet-api.ts';
import { api, argon2, chainReader } from '../app/services.ts';
import { decodeSafeTx } from '../chain/decoders.ts';
import { parseSafeTx, verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { decodeContext, onchainNonce } from '../operations/context.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { verifiedOrReleased } from '../operations/prepared.ts';
import { SETTLED_STATES } from '../operations/sign.ts';
import { transferCall } from '../send/send.ts';
import { useSensitiveScreen } from '../session/context.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { EnvelopeSource } from '../unlock/EnvelopeSource.tsx';
import { unlockWallet, type UnlockedWallet } from '../unlock/unlock.ts';
import { tokenBalance, verifyMigrationTarget } from './migration.ts';

export function MigrationPage() {
  useSensitiveScreen();
  const [approved, setApproved] = useState<AppNotification | null | undefined>(undefined);
  const [envelope, setEnvelope] = useState<KeyEnvelope | null>(null);
  const [old, setOld] = useState<UnlockedWallet | null>(null);
  const [plan, setPlan] = useState<{ preparation: MigrationPreparation; items: VerifiedOperation[] } | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .notifications({ limit: 100 })
      .then(({ items }) => {
        if (live) setApproved(items.find((n) => n.type === 'MIGRATION_APPROVED' && n.walletId !== null) ?? null);
      })
      .catch((caught: unknown) => {
        if (live) setError(describeError(caught));
      });
    return () => {
      live = false;
    };
  }, []);

  const oldWalletId = approved?.walletId ?? null;

  const unlock = useAsyncAction(
    useCallback(
      async (password: string) => {
        if (!envelope || oldWalletId === null) return;
        if (envelope.walletId !== oldWalletId) throw new Error('Ese sobre no es de la wallet que se migra.');
        setOld(await unlockWallet(api, envelope, password, argon2));
      },
      [envelope, oldWalletId],
    ),
  );

  const prepare = useAsyncAction(
    useCallback(async () => {
      if (!old || oldWalletId === null || old.session.safe === null) return;
      const oldSafe = old.session.safe;
      const preparation = await api.prepareMigration(old.platform, oldWalletId);
      const newSafe = preparation.destination.safe;
      // Si la Safe destino o alguna transferencia no verifica, lo preparado se cancela y no se firma nada.
      const items = await verifiedOrReleased(api, old.platform, preparation.operations, async () => {
        await verifyMigrationTarget(chainReader, systemContracts, {
          oldSafe,
          newSafe,
          userKey: old.envelope.keyAddress,
        });
        const nonce = await onchainNonce(chainReader, oldSafe);
        const ctx = decodeContext(oldSafe);
        const verified: VerifiedOperation[] = [];
        for (const operation of preparation.operations) {
          const call = decodeSafeTx(parseSafeTx(operation.safeTx), ctx);
          if (call.kind !== 'TRANSFER' || !isAddressEqual(call.recipient, newSafe)) {
            throw new Error('La plataforma preparó una operación que no es la transferencia a la Safe nueva.');
          }
          const token = call.token === 'USDC' ? pinnedChain.tokens.usdc : pinnedChain.tokens.usdt;
          const balance = await tokenBalance(chainReader, token.address, oldSafe);
          verified.push(
            verifyPrepared(operation, {
              safe: oldSafe,
              chainId: 8453,
              onchainNonce: nonce,
              build: (n) => transferCall(token, newSafe, balance, n),
            }),
          );
        }
        return verified;
      });
      setPlan({ preparation, items });
    }, [old, oldWalletId]),
  );

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="migration-title">
        <h1 id="migration-title">Migración excepcional</h1>
        {error && <Notice tone="error">{error}</Notice>}
        {approved === undefined && !error && <p className="muted">Buscando una migración aprobada…</p>}
        {approved === null && <Notice>No tenés una migración aprobada.</Notice>}
        {approved && !old && (
          <div className="stack">
            <p>Para firmar la migración, abrí el sobre de tu clave U de la wallet que se migra.</p>
            {!envelope ? (
              <EnvelopeSource onEnvelope={setEnvelope} />
            ) : (
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void unlock.run(formValue(event.currentTarget, 'passwordU'));
                }}
              >
                <Field label="Password U" name="passwordU" type="password" autoComplete="off" required />
                {unlock.error && <Notice tone="error">{unlock.error}</Notice>}
                <button type="submit" className="button" disabled={unlock.pending} aria-busy={unlock.pending}>
                  Desbloquear la wallet que se migra
                </button>
              </form>
            )}
          </div>
        )}
        {old && !plan && !done && (
          <div className="stack">
            {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
            <button
              type="button"
              className="button"
              disabled={prepare.pending}
              aria-busy={prepare.pending}
              onClick={() => void prepare.run()}
            >
              {prepare.pending ? 'Verificando la Safe destino…' : 'Preparar y verificar la migración'}
            </button>
          </div>
        )}
      </section>
      {plan && old && (
        <>
          <Notice tone="success">
            Safe destino verificada en Base: <AddressText address={plan.preparation.destination.safe} />
          </Notice>
          <OperationReview
            title="Revisá la transferencia de todo el saldo a tu Safe nueva"
            items={plan.items}
            unlocked={old}
            decode={decodeContext(old.session.safe ?? plan.preparation.destination.safe)}
            onSettled={(statuses) => {
              setDone(statuses.every((status) => SETTLED_STATES.includes(status.status)));
            }}
            onCancel={() => {
              setPlan(null);
            }}
          />
        </>
      )}
      {done && <Notice tone="success">Migración enviada: seguí el estado en la Actividad de tu Safe nueva.</Notice>}
    </div>
  );
}
