// Onboarding de U (P17.T05), en este orden: conectar Drive (la redirección recarga la app, por eso va antes de generar
// nada) → step-up ONBOARDING y wallet en creación → generar U → mostrar la Password U → confirmar 2 palabras → sobre
// cifrado → subir a Drive y verificar → backup independiente obligatorio → registro OPAQUE y alta de U. Sigue en P18:
// activar Recovery, confirmar R, crear la Safe.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { StorageFlags, WalletView } from '../api/wallet-api.ts';
import { api, argon2, driveOAuth } from '../app/services.ts';
import { appConfig } from '../config/index.ts';
import { zeroize } from '../crypto/bytes.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { startDriveConnect, takeDriveConnectError } from '../drive/oauth.ts';
import { hasDriveToken } from '../drive/token.ts';
import { useSession, useSessionStore, useSensitiveScreen } from '../session/context.tsx';
import { isLive, type StepUpSession } from '../session/step-up.ts';
import { StepUpForm } from '../session/StepUpForm.tsx';
import { rememberEnvelope } from '../storage/envelope-cache.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { BackupStep } from './BackupStep.tsx';
import { ConfirmPasswordWords, ShowPasswordWords } from './PasswordWords.tsx';
import {
  draftUserKey,
  ONBOARDING_KEY_VERSION,
  registerNewUserKey,
  sealUserKey,
  type DraftKey,
  type SealedKey,
} from './user-key.ts';

type Step = 'drive' | 'step-up' | 'key' | 'confirm' | 'seal' | 'backups' | 'register' | 'done';

export function OnboardingPage() {
  useSensitiveScreen();
  const store = useSessionStore();
  const { wallet } = useSession();
  const [step, setStep] = useState<Step>(() => (hasDriveToken() ? 'step-up' : 'drive'));
  const [connectError] = useState(() => takeDriveConnectError());
  const [stepUp, setStepUp] = useState<StepUpSession | null>(null);
  const [current, setCurrent] = useState<WalletView | null>(null);
  const [draft, setDraft] = useState<DraftKey | null>(null);
  const [sealed, setSealed] = useState<SealedKey | null>(null);
  const [remember, setRemember] = useState(true);
  const [flags, setFlags] = useState<StorageFlags | null>(null);

  useEffect(
    () => () => {
      // U en claro sólo vive mientras dura el alta.
      if (draft) zeroize(draft.key);
    },
    [draft],
  );

  const createWallet = useAsyncAction(
    useCallback(
      async (session: StepUpSession) => {
        const created = await api.createWallet(session.platform);
        setCurrent(created);
        await store.refreshWallet();
        setDraft(draftUserKey(await loadWordlist()));
        setStep('key');
      },
      [store],
    ),
  );

  const seal = useAsyncAction(
    useCallback(async () => {
      if (!draft || !current) return;
      const result = await sealUserKey(
        draft,
        draft.passwordWords.join(' '),
        { platformId: appConfig.platformId, walletId: current.id, keyVersion: ONBOARDING_KEY_VERSION },
        argon2,
      );
      if (remember) await rememberEnvelope(result.envelope);
      setSealed(result);
      setStep('backups');
    }, [current, draft, remember]),
  );

  const register = useAsyncAction(
    useCallback(
      async (session: StepUpSession, backups: StorageFlags) => {
        if (!sealed || !draft) return;
        await registerNewUserKey(api, session.platform, sealed, backups);
        zeroize(draft.key);
        await store.refreshWallet();
        setStep('done');
      },
      [draft, sealed, store],
    ),
  );

  if (wallet && wallet.status !== 'CREATING' && step !== 'done') {
    return (
      <section className="stack narrow">
        <h1>Tu wallet ya está creada</h1>
        <p>
          <Link to="/unlock">Desbloqueala</Link> para operar.
        </p>
      </section>
    );
  }

  return (
    <section className="stack narrow" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">Crear tu wallet</h1>
      <ol className="steps" aria-label="Pasos">
        {(['Drive', 'Identidad', 'Password U', 'Backups', 'Registro'] as const).map((label, i) => (
          <li key={label} className={stepIndex(step) >= i ? 'steps__item steps__item--done' : 'steps__item'}>
            {label}
          </li>
        ))}
      </ol>

      {step === 'drive' && (
        <article className="card stack" aria-labelledby="drive-title">
          <h2 id="drive-title">Conectá Google Drive</h2>
          <p>
            El sobre cifrado de tu clave se guarda en la carpeta privada de MT Wallet en tu Drive (backup adicional). Se
            conecta primero porque la autorización de Google recarga la página.
          </p>
          {connectError && <Notice tone="error">{connectError.message}</Notice>}
          <button
            type="button"
            className="button"
            disabled={driveOAuth === null}
            onClick={() => {
              startDriveConnect(driveOAuth, '/onboarding');
            }}
          >
            Conectar Google Drive
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setStep('step-up');
            }}
          >
            Seguir sin Drive
          </button>
        </article>
      )}

      {step === 'step-up' &&
        (stepUp && isLive(stepUp.session) ? (
          <Notice>Creando la wallet…</Notice>
        ) : (
          <StepUpForm
            scope="ONBOARDING"
            onSession={(session) => {
              setStepUp(session);
              void createWallet.run(session);
            }}
          />
        ))}
      {createWallet.error && <Notice tone="error">{createWallet.error}</Notice>}

      {step === 'key' && draft && (
        <ShowPasswordWords
          words={draft.passwordWords}
          onWritten={() => {
            setStep('confirm');
          }}
        />
      )}
      {step === 'confirm' && draft && (
        <ConfirmPasswordWords
          words={draft.passwordWords}
          onConfirmed={() => {
            setStep('seal');
          }}
          onBack={() => {
            setStep('key');
          }}
        />
      )}
      {step === 'seal' && (
        <article className="card stack" aria-labelledby="seal-title">
          <h2 id="seal-title">Cifrar tu clave</h2>
          <p>Tu clave se cifra en este navegador con la Password U. Puede tardar unos segundos.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => {
                setRemember(event.currentTarget.checked);
              }}
            />
            Recordar el sobre cifrado en este dispositivo (nunca la clave ni la Password U)
          </label>
          {seal.error && <Notice tone="error">{seal.error}</Notice>}
          <button type="button" className="button" disabled={seal.pending} onClick={() => void seal.run()}>
            {seal.pending ? 'Cifrando…' : 'Cifrar'}
          </button>
        </article>
      )}
      {step === 'backups' && sealed && draft && (
        <BackupStep
          envelope={sealed.envelope}
          wordsKey={draft.key}
          onDone={(backups) => {
            setFlags(backups);
            setStep('register');
          }}
        />
      )}
      {step === 'register' && flags && (
        <article className="card stack" aria-labelledby="register-key-title">
          <h2 id="register-key-title">Registrar tu clave</h2>
          <p>
            La plataforma recibe sólo la dirección de tu clave, los parámetros públicos del cifrado y qué backups
            hiciste.
          </p>
          {stepUp && isLive(stepUp.session) ? (
            <>
              {register.error && <Notice tone="error">{register.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={register.pending}
                onClick={() => void register.run(stepUp, flags)}
              >
                {register.pending ? 'Registrando…' : 'Registrar'}
              </button>
            </>
          ) : (
            <StepUpForm
              scope="ONBOARDING"
              onSession={(session) => {
                setStepUp(session);
              }}
            />
          )}
        </article>
      )}
      {step === 'done' && (
        <article className="card stack" aria-labelledby="done-title">
          <h2 id="done-title">Clave registrada</h2>
          <Notice tone="success">
            Tu clave U quedó registrada y respaldada. El próximo paso es activar tu clave de recuperación en la app
            Recovery.
          </Notice>
          <p>
            <Link to="/">Ir al inicio</Link>
          </p>
        </article>
      )}
    </section>
  );
}

function stepIndex(step: Step): number {
  return { drive: 0, 'step-up': 1, key: 2, confirm: 2, seal: 2, backups: 3, register: 4, done: 5 }[step];
}
