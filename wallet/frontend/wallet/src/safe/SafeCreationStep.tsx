// Crear la Safe (P18.T02): con U registrada y R confirmada, la plataforma asigna S y propone la Safe; la app verifica
// todo por su cuenta (atestación de S, dirección calculada con sus contratos fijados, typed data exacto), U firma la
// autorización propia, se despliega y la Safe se muestra operativa sólo si la verificación propia por el RPC del
// frontend da todo bien. Antes de firmar se muestran las direcciones de la Safe, U, R y S, qué autoriza la firma (2 de 3
// firmas para mover fondos, el gas lo paga la plataforma) y que no se manden fondos hasta que figure operativa.
import { useCallback, useState } from 'react';
import type { Address } from 'viem';
import type { PlatformAuth } from '../api/request-signature.ts';
import type { WalletView } from '../api/wallet-api.ts';
import { api, chainReader } from '../app/services.ts';
import { pinnedChain } from '../config/chain.ts';
import { appConfig, systemContracts } from '../config/index.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { AddressText } from '../ui/AddressText.tsx';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import {
  authorizationBody,
  signCreationAuthorization,
  verifyExecutorAssignment,
  waitForDeployment,
  type CreationPlan,
} from './creation.ts';
import { failureText } from './gate.ts';
import { verifySafe } from './verify.ts';

type Progress = 'idle' | 'signing' | 'deploying' | 'verifying' | 'active';

const PROGRESS_TEXT: Record<Progress, string> = {
  idle: '',
  signing: 'Firmando la autorización con tu clave U…',
  deploying: 'Desplegando tu Safe en Base…',
  verifying: 'Verificando tu Safe en Base desde esta app…',
  active: 'Tu Safe está operativa.',
};

export function SafeCreationStep({
  walletId,
  userId,
  platform,
  userKey,
  recovery,
  onActive,
}: {
  walletId: string;
  userId: string;
  platform: PlatformAuth;
  userKey: { envelope: KeyEnvelope; encryptionKey: CryptoKey };
  recovery: { recoveryKey: Address; enrollmentId: string; enrollmentNonce: `0x${string}` | null };
  onActive: (wallet: WalletView) => void;
}) {
  const [plan, setPlan] = useState<CreationPlan | null>(null);
  const [progress, setProgress] = useState<Progress>('idle');
  const [failures, setFailures] = useState<string[]>([]);

  const prepare = useAsyncAction(
    useCallback(async () => {
      const assignment = await api.assignExecutor(platform, walletId);
      setPlan(
        await verifyExecutorAssignment(
          assignment,
          {
            walletId,
            userId,
            platformId: appConfig.platformId,
            userKey: userKey.envelope.keyAddress,
            recoveryKey: recovery.recoveryKey,
            enrollmentId: recovery.enrollmentId,
            enrollmentNonce: recovery.enrollmentNonce,
          },
          { chain: pinnedChain, system: systemContracts },
        ),
      );
    }, [platform, walletId, userId, userKey, recovery]),
  );

  const create = useAsyncAction(
    useCallback(async () => {
      if (!plan) return;
      setProgress('signing');
      const signature = await signCreationAuthorization(userKey, plan);
      await api.incorporateRecoveryKey(platform, plan.enrollmentId, authorizationBody(plan, signature));
      setProgress('deploying');
      await api.deployWallet(platform, walletId);
      const wallet = await waitForDeployment(api, walletId);
      setProgress('verifying');
      const result = await verifySafe(
        chainReader,
        { chain: pinnedChain, system: systemContracts },
        { kind: 'creation', safe: plan.expectedSafe, keys: plan.keys, saltNonce: plan.saltNonce },
      );
      if (!result.ok) {
        setFailures(result.failures);
        setProgress('idle');
        throw new Error('La verificación propia de la Safe falló: la app no la usa.');
      }
      setProgress('active');
      onActive(wallet);
    }, [plan, userKey, platform, walletId, onActive]),
  );

  return (
    <article className="card stack" aria-labelledby="safe-title">
      <h2 id="safe-title">Crear tu Safe</h2>
      {!plan && (
        <>
          <p>
            La plataforma asigna su clave (S) y calcula la dirección de tu Safe. Esta app verifica todo por su cuenta
            antes de que firmes.
          </p>
          {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={prepare.pending}
            aria-busy={prepare.pending}
            onClick={() => void prepare.run()}
          >
            {prepare.pending ? 'Preparando…' : 'Preparar la Safe'}
          </button>
        </>
      )}
      {plan && (
        <div className="stack">
          <dl className="summary" data-expected-safe={plan.expectedSafe}>
            <dt>Dirección de tu Safe (calculada por esta app)</dt>
            <dd>
              <AddressText address={plan.expectedSafe} />
            </dd>
            <dt>Dirección de tu clave U</dt>
            <dd>
              <AddressText address={plan.keys.userKey} />
            </dd>
            <dt>Dirección de tu clave R (confirmada)</dt>
            <dd>
              <AddressText address={plan.keys.recoveryKey} />
            </dd>
            <dt>Dirección de la clave de la plataforma (S, verificada por esta app)</dt>
            <dd>
              <AddressText address={plan.keys.executor} />
            </dd>
          </dl>
          <p>
            Tu Safe va a tener tres firmantes: tus claves U y R, más la de la plataforma (S). Para mover fondos hacen
            falta 2 de esas 3 firmas.
          </p>
          <p>
            Al firmar, tu clave U autoriza crear esta Safe con exactamente estas direcciones. El gas del despliegue lo
            paga la plataforma.
          </p>
          <Notice tone="warning">
            No mandes fondos a la dirección de tu Safe hasta que esta app la muestre como operativa.
          </Notice>
          {progress !== 'idle' && (
            <p role="status" data-progress={progress}>
              {PROGRESS_TEXT[progress]}
            </p>
          )}
          {failures.length > 0 && (
            <Notice tone="error">
              <ul className="failures">
                {failures.map((item) => (
                  <li key={item} data-item={item}>
                    {failureText(item)}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {create.error && <Notice tone="error">{create.error}</Notice>}
          {progress !== 'active' && (
            <button
              type="button"
              className="button"
              disabled={create.pending}
              aria-busy={create.pending}
              onClick={() => void create.run()}
            >
              {create.pending ? 'Creando…' : 'Firmar y crear la Safe'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
