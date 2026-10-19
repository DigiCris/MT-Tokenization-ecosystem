// Onboarding (P17.T05 y P18.T01/T02), en este orden: conectar Drive (la redirección recarga la app, por eso va antes
// de generar nada) → step-up ONBOARDING y wallet en creación → generar U → mostrar la Password U → confirmar 2 palabras
// → sobre cifrado (64 MiB, o 128 MiB como opción avanzada para computadoras, [F-KEY-03]) → subir a Drive y verificar →
// backup independiente obligatorio → registro OPAQUE y alta de U → activar Recovery y confirmar R → crear la Safe con
// la verificación propia. Si la pestaña se recargó con U ya registrada, se retoma abriendo el sobre con la Password U
// (U sólo se descifra para firmar la autorización). El indicador de pasos marca el actual con aria-current.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { isAddressEqual, type Address } from 'viem';
import type { StorageFlags, WalletView } from '../api/wallet-api.ts';
import { api, argon2, driveOAuth } from '../app/services.ts';
import { appConfig } from '../config/index.ts';
import { zeroize } from '../crypto/bytes.ts';
import { keysForEnvelope, openEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { normalizePassword } from '../crypto/password.ts';
import { confirmWithReturnLink } from '../recovery-activation/activation.ts';
import { RecoveryActivationStep, type ConfirmedRecovery } from '../recovery-activation/RecoveryActivationStep.tsx';
import { SafeCreationStep } from '../safe/SafeCreationStep.tsx';
import { EnvelopeSource } from '../unlock/EnvelopeSource.tsx';
import { loadWordlist } from '../crypto/wordlist.ts';
import { startDriveConnect, takeDriveConnectError } from '../drive/oauth.ts';
import { hasDriveToken } from '../drive/token.ts';
import { useSession, useSessionStore, useSensitiveScreen } from '../session/context.tsx';
import { isLive, type StepUpSession } from '../session/step-up.ts';
import { StepUpForm } from '../session/StepUpForm.tsx';
import { rememberEnvelope } from '../storage/envelope-cache.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import { BackupStep } from './BackupStep.tsx';
import { ConfirmPasswordWords, ShowPasswordWords } from './PasswordWords.tsx';
import {
  draftUserKey,
  LOST_U_AND_R_WARNING,
  ONBOARDING_KEY_VERSION,
  registerNewUserKey,
  sealUserKey,
  userKeyMemoryKiB,
  type DraftKey,
  type SealedKey,
} from './user-key.ts';

type Step =
  'drive' | 'step-up' | 'key' | 'confirm' | 'seal' | 'backups' | 'register' | 'resume' | 'recovery' | 'safe' | 'done';

// "Recovery" es el nombre de la app; "Backups", el término que usa toda la app.
const STEP_LABELS = ['Drive', 'Identidad', 'Password U', 'Backups', 'Registro', 'Recovery', 'Safe'] as const;

/** U ya registrada: sobre y K_U (no exportable) en memoria; U se descifra sólo para firmar. */
interface UserKeyInMemory {
  envelope: KeyEnvelope;
  encryptionKey: CryptoKey;
}

export function OnboardingPage({ returned }: { returned?: { enrollmentId: string; recoveryKey: Address } } = {}) {
  useSensitiveScreen();
  const store = useSessionStore();
  const { wallet, user } = useSession();
  const [step, setStep] = useState<Step>(() => (hasDriveToken() ? 'step-up' : 'drive'));
  const [userKey, setUserKey] = useState<UserKeyInMemory | null>(null);
  const [recovery, setRecovery] = useState<ConfirmedRecovery | null>(null);
  const [registeredU, setRegisteredU] = useState<Address | null>(null);
  const [resumeEnvelope, setResumeEnvelope] = useState<KeyEnvelope | null>(null);
  const [connectError] = useState(() => takeDriveConnectError());
  const [stepUp, setStepUp] = useState<StepUpSession | null>(null);
  const [current, setCurrent] = useState<WalletView | null>(null);
  const [draft, setDraft] = useState<DraftKey | null>(null);
  const [sealed, setSealed] = useState<SealedKey | null>(null);
  const [remember, setRemember] = useState(true);
  // [F-KEY-03]: opción avanzada de 128 MiB, desactivada por defecto y ofrecida sólo en computadoras (puntero fino).
  const [desktop] = useState(() => window.matchMedia('(pointer: fine)').matches);
  const [desktopKdf, setDesktopKdf] = useState(false);
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
        userKeyMemoryKiB(desktopKdf),
      );
      if (remember) await rememberEnvelope(result.envelope);
      setSealed(result);
      setStep('backups');
    }, [current, draft, remember, desktopKdf]),
  );

  const register = useAsyncAction(
    useCallback(
      async (session: StepUpSession, backups: StorageFlags) => {
        if (!sealed || !draft) return;
        await registerNewUserKey(api, session.platform, sealed, backups);
        zeroize(draft.key);
        await store.refreshWallet();
        setUserKey({ envelope: sealed.envelope, encryptionKey: sealed.encryptionKey });
        setStep('recovery');
      },
      [draft, sealed, store],
    ),
  );

  // Pestaña recargada con la wallet en creación y U ya registrada: se retoma abriendo el sobre.
  useEffect(() => {
    if (wallet?.status !== 'CREATING' || userKey !== null || draft !== null) return;
    let live = true;
    void api.walletDeployment(wallet.id).then((deployment) => {
      if (!live || deployment.U === null) return;
      setRegisteredU(deployment.U);
      setStep('resume');
    });
    return () => {
      live = false;
    };
  }, [wallet, userKey, draft]);

  const resume = useAsyncAction(
    useCallback(
      async (password: string) => {
        if (!resumeEnvelope || !wallet || registeredU === null) return;
        if (resumeEnvelope.walletId !== wallet.id || !isAddressEqual(resumeEnvelope.keyAddress, registeredU)) {
          throw new Error('Ese sobre no es el de la clave U registrada para esta wallet.');
        }
        const keys = await keysForEnvelope(resumeEnvelope, normalizePassword(password), argon2);
        if (keys.authSecret) zeroize(keys.authSecret);
        // Comprueba la Password U contra el sobre: U se descifra y se borra en el acto.
        zeroize(await openEnvelope(resumeEnvelope, keys.encryptionKey));
        setUserKey({ envelope: resumeEnvelope, encryptionKey: keys.encryptionKey });
        setStep('recovery');
      },
      [resumeEnvelope, wallet, registeredU],
    ),
  );

  // Link de regreso de Recovery abierto en esta pestaña (ninguna otra lo tomó): R del enrollment de ese link.
  const fromReturn = useAsyncAction(
    useCallback(async () => {
      if (!returned) return;
      const enrollment = await api.getRecoveryEnrollment(returned.enrollmentId);
      const recoveryKey = confirmWithReturnLink(enrollment, returned);
      setRecovery({ recoveryKey, enrollmentId: enrollment.id, enrollmentNonce: null });
      setStep('safe');
    }, [returned]),
  );

  const live = stepUp !== null && isLive(stepUp.session);
  const stepUpForm = (
    <StepUpForm
      scope="ONBOARDING"
      onSession={(session) => {
        setStepUp(session);
      }}
    />
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

  const currentStep = stepIndex(step);
  return (
    <section className="stack narrow" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">Crear tu wallet</h1>
      <ol className="steps" aria-label="Pasos">
        {STEP_LABELS.map((label, i) => (
          <li
            key={label}
            className={
              i < currentStep
                ? 'steps__item steps__item--done'
                : i === currentStep
                  ? 'steps__item steps__item--current'
                  : 'steps__item'
            }
            aria-current={i === currentStep ? 'step' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      {step === 'drive' && (
        <article className="card stack" aria-labelledby="drive-title">
          <h2 id="drive-title">Conectá Google Drive</h2>
          <p>
            El sobre cifrado de tu clave se guarda en una carpeta privada de MT Wallet en tu Drive. Esa carpeta no
            aparece entre tus archivos de Drive y se borra si desconectás MT Wallet de tu Drive o borrás sus datos
            ocultos: por eso es un backup adicional y después te pedimos otro que no dependa de Drive.
          </p>
          <p>Se conecta primero porque la autorización de Google recarga la página.</p>
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
          <p className="muted">
            Sin Drive seguís igual: en el paso de backups guardás el archivo cifrado, el QR o las 17 palabras, y más
            adelante podés subir el sobre a Drive desde Seguridad.
          </p>
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
            Recordar el sobre cifrado en este dispositivo (nunca la clave ni la Password U). Si la computadora es
            compartida, desmarcalo.
          </label>
          {desktop && (
            <details className="advanced">
              <summary>Opciones avanzadas</summary>
              <div className="stack">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={desktopKdf}
                    onChange={(event) => {
                      setDesktopKdf(event.currentTarget.checked);
                    }}
                  />
                  Cifrado reforzado para computadoras: 128 MiB de memoria en lugar de 64 MiB
                </label>
                <Notice tone="warning">
                  Un sobre cifrado con 128 MiB puede no abrir en celulares: si alguna vez vas a usar tu wallet en un
                  celular, dejá esta opción desmarcada.
                </Notice>
              </div>
            </details>
          )}
          {seal.error && <Notice tone="error">{seal.error}</Notice>}
          <button
            type="button"
            className="button"
            disabled={seal.pending}
            aria-busy={seal.pending}
            onClick={() => void seal.run()}
          >
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
            La plataforma recibe sólo la dirección de tu clave, los parámetros públicos del cifrado, qué backups hiciste
            y un registro que le permite comprobar tu Password U sin conocerla.
          </p>
          {stepUp && isLive(stepUp.session) ? (
            <>
              {register.error && <Notice tone="error">{register.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={register.pending}
                aria-busy={register.pending}
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
      {step === 'resume' && (
        <article className="card stack" aria-labelledby="resume-title">
          <h2 id="resume-title">Seguir con la creación</h2>
          <p>
            Tu clave U ya está registrada. Para seguir abrí tu sobre cifrado con tu Password U: se descifra en este
            navegador y no se envía a ningún lado.
          </p>
          {resumeEnvelope === null ? (
            <EnvelopeSource onEnvelope={setResumeEnvelope} />
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void resume.run(formValue(event.currentTarget, 'passwordU'));
              }}
            >
              <Field label="Password U" name="passwordU" type="password" autoComplete="off" required />
              {resume.error && <Notice tone="error">{resume.error}</Notice>}
              <button type="submit" className="button" disabled={resume.pending} aria-busy={resume.pending}>
                {resume.pending ? 'Abriendo el sobre…' : 'Abrir el sobre'}
              </button>
            </form>
          )}
        </article>
      )}
      {step === 'recovery' &&
        wallet &&
        userKey &&
        (live ? (
          returned ? (
            <article className="card stack" aria-labelledby="return-title">
              <h2 id="return-title">Confirmar la dirección de tu clave R</h2>
              <p>
                Volviste desde la app Recovery: se compara la dirección de la clave R que trae el enlace con la que
                recibió la plataforma para ese pedido.
              </p>
              {fromReturn.error && <Notice tone="error">{fromReturn.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={fromReturn.pending}
                aria-busy={fromReturn.pending}
                onClick={() => void fromReturn.run()}
              >
                Confirmar la dirección de R
              </button>
            </article>
          ) : (
            <RecoveryActivationStep
              walletId={wallet.id}
              platform={stepUp.platform}
              intro="Tu clave de recuperación (R) vive en la app Recovery, separada de esta. Con U y R podés recuperar tu wallet sin la plataforma."
              warning={LOST_U_AND_R_WARNING}
              onConfirmed={(confirmed) => {
                setRecovery(confirmed);
                setStep('safe');
              }}
            />
          )
        ) : (
          stepUpForm
        ))}
      {step === 'safe' &&
        wallet &&
        user &&
        userKey &&
        recovery &&
        (live ? (
          <SafeCreationStep
            walletId={wallet.id}
            userId={user.id}
            platform={stepUp.platform}
            userKey={userKey}
            recovery={recovery}
            onActive={() => {
              void store.refreshWallet();
              setStep('done');
            }}
          />
        ) : (
          stepUpForm
        ))}
      {step === 'done' && (
        <article className="card stack" aria-labelledby="done-title">
          <h2 id="done-title">Tu Safe está operativa</h2>
          <Notice tone="success">
            Tu Safe quedó creada en Base y esta app la verificó. Sus firmantes son tus claves U y R, más la de la
            plataforma (S).
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
  return {
    drive: 0,
    'step-up': 1,
    key: 2,
    confirm: 2,
    seal: 2,
    backups: 3,
    register: 4,
    resume: 4,
    recovery: 5,
    safe: 6,
    done: 7,
  }[step];
}
