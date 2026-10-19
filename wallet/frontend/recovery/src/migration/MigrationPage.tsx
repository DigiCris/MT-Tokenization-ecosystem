// `/migration` (P19.T10): migración excepcional con R como credencial sana. La plataforma prepara un MIGRATION_TRANSFER
// por token con saldo desde la Safe vieja (MIGRATING); antes de que R firme, la app verifica on-chain la Safe destino
// (factory, Guard con la misma R, owners = roles, autorización del PolicyRegistry) y arma cada transfer del saldo
// completo leído de la cadena. Si algo no coincide, lo preparado se cancela y no se firma nada.
import { useCallback, useState } from 'react';
import type { MigrationPreparation } from '../api/recovery-api.ts';
import { api, pinned, reader } from '../app/services.ts';
import { safeNonce } from '../chain/rotations.ts';
import { parseSafeTx, verifyPrepared, type VerifiedOperation } from '../chain/safe-tx.ts';
import { OperationReview } from '../operations/OperationReview.tsx';
import { releasePrepared, SETTLED_STATES, verifiedOrReleased } from '../operations/sign.ts';
import { useSensitiveScreen } from '../session/context.tsx';
import { RecoveryGate, type RecoveryContext } from '../session/RecoveryGate.tsx';
import { AddressText } from '../ui/AddressText.tsx';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { migrationToken, migrationTransferCall, tokenBalance, verifyMigrationTarget } from './migration.ts';

function Migration({ ctx }: { ctx: RecoveryContext }) {
  const { platform, signer, walletId, safe } = ctx;
  const [plan, setPlan] = useState<{ preparation: MigrationPreparation; items: VerifiedOperation[] } | null>(null);
  const [done, setDone] = useState(false);

  const prepare = useAsyncAction(
    useCallback(async () => {
      await releasePrepared(api, platform);
      const preparation = await api.prepareMigration(platform.auth, walletId);
      const newSafe = preparation.destination.safe;
      const items = await verifiedOrReleased(api, platform, preparation.operations, async () => {
        await verifyMigrationTarget(reader, pinned.system, { oldSafe: safe, newSafe, recoveryKey: signer.address });
        const nonce = await safeNonce(reader, safe);
        const verified: VerifiedOperation[] = [];
        for (const operation of preparation.operations) {
          const token = migrationToken(parseSafeTx(operation.safeTx), pinned.chain, newSafe);
          const balance = await tokenBalance(reader, token.address, safe);
          verified.push(
            verifyPrepared(operation, {
              safe,
              chainId: 8453,
              onchainNonce: nonce,
              build: (n) => migrationTransferCall(token, newSafe, balance, n),
            }),
          );
        }
        return verified;
      });
      setPlan({ preparation, items });
    }, [platform, walletId, safe, signer.address]),
  );

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="migration-title">
        <h1 id="migration-title">Migración excepcional</h1>
        <p>
          La plataforma aprobó mover tus fondos a una Safe nueva que conserva tu clave R. Antes de firmar, esta app
          verifica en Base la Safe destino y arma ella misma cada transferencia.
        </p>
        {!plan && !done && (
          <>
            {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
            <button type="button" className="button" disabled={prepare.pending} onClick={() => void prepare.run()}>
              {prepare.pending ? 'Verificando la Safe destino…' : 'Preparar y verificar la migración'}
            </button>
          </>
        )}
      </section>
      {plan && (
        <>
          <Notice tone="success">
            Safe destino verificada en Base: <AddressText address={plan.preparation.destination.safe} />
          </Notice>
          <OperationReview
            title="Revisá la transferencia de todo el saldo a tu Safe nueva"
            items={plan.items}
            platform={platform}
            signer={signer}
            onSettled={(statuses) => {
              const settled = statuses.every((status) => SETTLED_STATES.includes(status.status));
              setDone(settled);
              if (settled) setPlan(null);
            }}
            onCancel={() => {
              setPlan(null);
            }}
          />
        </>
      )}
      {done && <Notice tone="success">Migración enviada: tus fondos están en la Safe nueva.</Notice>}
    </div>
  );
}

export function MigrationPage() {
  useSensitiveScreen();
  return <RecoveryGate>{(ctx) => <Migration ctx={ctx} />}</RecoveryGate>;
}
