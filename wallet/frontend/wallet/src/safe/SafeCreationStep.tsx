// Crear la Safe (P18.T02): con U registrada y R confirmada, la plataforma asigna S y propone la Safe; la app verifica
// todo por su cuenta (atestación de S, dirección calculada con sus contratos fijados, typed data exacto), U firma la
// autorización propia, se despliega y la Safe se muestra operativa sólo si la verificación propia por el RPC del
// frontend da todo bien.
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
  verifying: 'Verificando tu Safe por tu cuenta (V9 §16)…',
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
          <button type="button" className="button" disabled={prepare.pending} onClick={() => void prepare.run()}>
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
            <dt>Tu clave U</dt>
            <dd>
              <AddressText address={plan.keys.userKey} />
            </dd>
            <dt>Tu clave R (confirmada)</dt>
            <dd>
              <AddressText address={plan.keys.recoveryKey} />
            </dd>
            <dt>Clave de la plataforma S (atestada por el signer, shard {plan.shardId})</dt>
            <dd>
              <AddressText address={plan.keys.executor} />
            </dd>
          </dl>
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
            <button type="button" className="button" disabled={create.pending} onClick={() => void create.run()}>
              {create.pending ? 'Creando…' : 'Firmar y crear la Safe'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
