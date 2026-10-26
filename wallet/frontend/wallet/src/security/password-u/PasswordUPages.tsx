// Cambio de Password U [F-KEY-08] y "perdí mi Password U" (P17.T07). El cambio exige la wallet desbloqueada (OPERATIONS):
// Password U nueva → sobre nuevo de la misma U → Drive y archivo → registro OPAQUE nuevo (el anterior se retira). Si se
// perdió la Password U: con las 17 palabras se restaura la misma U en /restore ([F-KEY-10](c), sin R ni timelock); si
// no, step-up U_REPLACEMENT → U' con su Password U' y backups → KeyAcceptance → handoff a Recovery (necesita R), con la
// dirección de U' que generó esta app a la vista: en Recovery se tipean sus 10 grupos para compararlos con la del backend.
// Cuarta revisión de P17.MAN: lo que se necesita de R incluye el sobre que recuerda Recovery (hallazgo 7) y el handoff
// se abre donde se va a usar R, también con sólo uno de sus backups (hallazgo 6); los backups de U′ llevan su dirección.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Address } from 'viem';
import type { StorageFlags } from '../../api/wallet-api.ts';
import { api, argon2, driveOAuth, walletFactory } from '../../app/services.ts';
import { appConfig } from '../../config/index.ts';
import { zeroize } from '../../crypto/bytes.ts';
import { generatePassword } from '../../crypto/password.ts';
import { loadWordlist } from '../../crypto/wordlist.ts';
import { startDriveConnect } from '../../drive/oauth.ts';
import { hasDriveToken } from '../../drive/token.ts';
import { BackupStep } from '../../onboarding/BackupStep.tsx';
import { ConfirmPasswordWords, ShowPasswordWords } from '../../onboarding/PasswordWords.tsx';
import { draftUserKey, type DraftKey } from '../../onboarding/user-key.ts';
import { useSession, useSessionStore, useSensitiveScreen } from '../../session/context.tsx';
import type { StepUpSession } from '../../session/step-up.ts';
import { StepUpForm } from '../../session/StepUpForm.tsx';
import { rememberedEnvelope, rememberEnvelope } from '../../storage/envelope-cache.ts';
import { AddressText } from '../../ui/AddressText.tsx';
import { Notice, useAsyncAction } from '../../ui/forms.tsx';
import { QrCanvas } from '../../ui/QrCanvas.tsx';
import { commitNewPassword, resealWithNewPassword, type ResealedKey } from './change.ts';
import {
  NEW_USER_KEY_COMPARE_TEXT,
  prepareReplacement,
  recoveryHandoffUrl,
  registerReplacement,
  type PreparedReplacement,
} from './lost.ts';

function DriveFirst({ returnTo }: { returnTo: string }) {
  if (hasDriveToken()) return <Notice tone="success">Google Drive conectado: el sobre nuevo se va a subir ahí.</Notice>;
  return (
    <Notice>
      Si querés guardar el sobre nuevo en Drive, conectalo antes de empezar (la autorización recarga la página).{' '}
      <button
        type="button"
        className="button button--link"
        disabled={driveOAuth === null}
        onClick={() => {
          startDriveConnect(driveOAuth, returnTo);
        }}
      >
        Conectar Google Drive
      </button>
    </Notice>
  );
}

type ChangeStep = 'start' | 'show' | 'confirm' | 'backups' | 'done';

/**
 * La wallet se bloqueó (inactividad, vencimiento o «Bloquear») antes de registrar la Password U nueva: la plataforma
 * sigue con la anterior. Los backups de la nueva abren la clave, pero con ellos no se inicia la sesión de operaciones.
 */
export const CHANGE_INTERRUPTED_TEXT =
  'La wallet se bloqueó antes de registrar la Password U nueva, así que sigue valiendo la anterior: desbloqueá con ella y empezá el cambio de nuevo (vas a tener otra Password U nueva). Los backups que hiciste con la que no se registró, incluida la copia de Drive si la subiste, reemplazalos con los del cambio nuevo.';

export function ChangePasswordUPage() {
  useSensitiveScreen();
  const store = useSessionStore();
  const { unlocked } = useSession();
  const [step, setStep] = useState<ChangeStep>('start');
  const [words, setWords] = useState<string[] | null>(null);
  const [resealed, setResealed] = useState<ResealedKey | null>(null);

  const reseal = useAsyncAction(
    useCallback(async () => {
      if (!unlocked || !words) return;
      setResealed(await resealWithNewPassword(unlocked, words.join(' '), argon2));
      setStep('backups');
    }, [unlocked, words]),
  );
  const commit = useAsyncAction(
    useCallback(
      async (flags: StorageFlags) => {
        if (!unlocked || !resealed) return;
        const next = await commitNewPassword(api, unlocked, resealed, flags);
        store.replaceUnlocked(next);
        if ((await rememberedEnvelope()) !== null) await rememberEnvelope(next.envelope);
        setStep('done');
      },
      [resealed, store, unlocked],
    ),
  );

  if (!unlocked && step !== 'done') {
    return (
      <section className="stack narrow">
        <h1>Cambiar la Password U</h1>
        {/* Se bloqueó a mitad del cambio: la Password U nueva nunca se registró. */}
        {step !== 'start' && <Notice tone="warning">{CHANGE_INTERRUPTED_TEXT}</Notice>}
        <DriveFirst returnTo="/security/password-u" />
        <Notice>
          Para cambiarla, primero{' '}
          <Link to="/unlock" state={{ returnTo: '/security/password-u' }}>
            desbloqueá la wallet
          </Link>{' '}
          con la Password U actual.
        </Notice>
      </section>
    );
  }
  return (
    <section className="stack narrow" aria-labelledby="change-title">
      <h1 id="change-title">Cambiar la Password U</h1>
      {step === 'start' && (
        <article className="card stack">
          <p>
            Tu clave no cambia: se vuelve a cifrar con una Password U nueva de 5 palabras. Los backups viejos (archivo,
            QR y Drive) siguen abriendo con la Password U anterior hasta que los reemplaces; el desbloqueo con la
            anterior deja de funcionar.
          </p>
          <DriveFirst returnTo="/security/password-u" />
          <button
            type="button"
            className="button"
            onClick={() => {
              void loadWordlist().then((list) => {
                setWords(generatePassword(list));
                setStep('show');
              });
            }}
          >
            Generar la Password U nueva
          </button>
        </article>
      )}
      {step === 'show' && words && unlocked && (
        <ShowPasswordWords
          words={words}
          keyAddress={unlocked.envelope.keyAddress}
          onWritten={() => {
            setStep('confirm');
          }}
        />
      )}
      {step === 'confirm' && words && (
        <>
          <ConfirmPasswordWords
            words={words}
            onConfirmed={() => void reseal.run()}
            onBack={() => {
              setStep('show');
            }}
          />
          {reseal.pending && <p role="status">Cifrando con la Password U nueva…</p>}
          {reseal.error && <Notice tone="error">{reseal.error}</Notice>}
        </>
      )}
      {step === 'backups' && resealed && (
        <>
          <BackupStep
            envelope={resealed.envelope}
            onDone={(flags) => void commit.run(flags)}
            continueLabel="Cambiar la Password U"
          />
          {commit.pending && <p role="status">Registrando la Password U nueva…</p>}
          {commit.error && <Notice tone="error">{commit.error}</Notice>}
        </>
      )}
      {step === 'done' && (
        <Notice tone="success">
          Listo: la Password U nueva quedó registrada. Usala desde ahora para desbloquear; la anterior ya no sirve.
        </Notice>
      )}
    </section>
  );
}

type LostStep = 'intro' | 'step-up' | 'show' | 'confirm' | 'backups' | 'done';

export function LostPasswordUPage() {
  useSensitiveScreen();
  const { wallet } = useSession();
  const [step, setStep] = useState<LostStep>('intro');
  const [stepUp, setStepUp] = useState<StepUpSession | null>(null);
  const [draft, setDraft] = useState<DraftKey | null>(null);
  const [prepared, setPrepared] = useState<PreparedReplacement | null>(null);
  // El enlace a Recovery y la dirección de U' que generó esta app (la que el usuario copia en Recovery).
  const [handoff, setHandoff] = useState<{ url: string; newKey: Address } | null>(null);

  useEffect(
    () => () => {
      if (draft) zeroize(draft.key);
    },
    [draft],
  );

  const prepare = useAsyncAction(
    useCallback(async () => {
      if (!stepUp || !draft) return;
      setPrepared(
        await prepareReplacement(api, stepUp, draft, draft.passwordWords.join(' '), appConfig.platformId, argon2),
      );
      setStep('backups');
    }, [draft, stepUp]),
  );
  const register = useAsyncAction(
    useCallback(
      async (flags: StorageFlags) => {
        if (!stepUp || !draft || !prepared) return;
        const result = await registerReplacement(api, stepUp, draft, prepared, flags, walletFactory);
        zeroize(draft.key);
        // La U' local (registerReplacement ya comprobó que la plataforma informa la misma), nunca la del backend.
        setHandoff({
          url: recoveryHandoffUrl(appConfig.recoveryOrigin, result.rotationId, draft.address),
          newKey: draft.address,
        });
        setStep('done');
      },
      [draft, prepared, stepUp],
    ),
  );

  return (
    <section className="stack narrow" aria-labelledby="lost-title">
      <h1 id="lost-title">Perdí mi Password U</h1>
      {step === 'intro' && (
        <article className="card stack">
          <p>
            Si tenés las 17 palabras de tu clave, no necesitás esto:{' '}
            <Link to="/restore" reloadDocument>
              restaurá tu clave con las 17 palabras
            </Link>{' '}
            y elegí una Password U nueva, sin usar tu clave R y sin esperar 48 horas.
          </p>
          <p>
            Si no las tenés, sin la Password U tu clave actual no se puede usar. Vas a crear una clave U nueva (con su
            Password U y sus backups), y tu clave de recuperación R va a proponer el reemplazo desde la app Recovery. El
            cambio se puede ejecutar recién después de 48 horas, desde la app Recovery: te avisamos por email y en la
            app, y si no fuiste vos, cancelalo en <Link to="/security/rotations">Seguridad → Rotaciones</Link>.
          </p>
          <Notice tone="warning">
            Hacé esto sólo si de verdad perdiste la Password U: si la recordás, cambiala desde Seguridad. Y necesitás tu
            clave R (el sobre que recuerda Recovery en tu dispositivo o uno de sus backups, y para abrir el sobre, la
            Password R): si también la perdiste, nadie puede reemplazar U, porque tu Safe necesita 2 de sus 3 firmas y
            con la clave de la plataforma sola no alcanza.
          </Notice>
          <DriveFirst returnTo="/security/lost-password-u" />
          <button
            type="button"
            className="button"
            disabled={wallet?.status !== 'ACTIVE'}
            onClick={() => {
              setStep('step-up');
            }}
          >
            Empezar
          </button>
          {wallet?.status !== 'ACTIVE' && <Notice>Esto sólo aplica a una wallet activa.</Notice>}
        </article>
      )}
      {step === 'step-up' && (
        <StepUpForm
          scope="U_REPLACEMENT"
          onSession={(session) => {
            setStepUp(session);
            void loadWordlist().then((list) => {
              setDraft(draftUserKey(list));
              setStep('show');
            });
          }}
        />
      )}
      {step === 'show' && draft && (
        <ShowPasswordWords
          words={draft.passwordWords}
          keyAddress={draft.address}
          onWritten={() => {
            setStep('confirm');
          }}
        />
      )}
      {step === 'confirm' && draft && (
        <>
          <ConfirmPasswordWords
            words={draft.passwordWords}
            onConfirmed={() => void prepare.run()}
            onBack={() => {
              setStep('show');
            }}
          />
          {prepare.pending && <p role="status">Cifrando la clave nueva…</p>}
          {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
        </>
      )}
      {step === 'backups' && prepared && draft && (
        <>
          <BackupStep
            envelope={prepared.envelope}
            wordsKey={draft.key}
            onDone={(flags) => void register.run(flags)}
            continueLabel="Registrar la clave nueva"
          />
          {register.error && <Notice tone="error">{register.error}</Notice>}
        </>
      )}
      {step === 'done' && handoff && (
        <article className="card stack" aria-labelledby="handoff-title">
          <h2 id="handoff-title">Seguí en la app Recovery</h2>
          <section className="stack" aria-labelledby="new-user-key-title" data-new-user-key={handoff.newKey}>
            <h3 id="new-user-key-title">Dirección de tu clave U nueva</h3>
            <p>
              <AddressText address={handoff.newKey} copy />
            </p>
            <Notice tone="warning">{NEW_USER_KEY_COMPARE_TEXT}</Notice>
          </section>
          <p>
            Abrí este enlace (o escaneá el QR) en el dispositivo donde vas a usar tu clave de recuperación (el que la
            recuerda, o cualquiera con uno de sus backups).
          </p>
          <QrCanvas text={handoff.url} label="QR para continuar en Recovery" />
          <p>
            <a href={handoff.url} rel="noopener" data-testid="recovery-handoff">
              Continuar en Recovery
            </a>
          </p>
        </article>
      )}
    </section>
  );
}
