// Restauración de U en un dispositivo nuevo (P17.T09, [F-KEY-10]): desde Drive, archivo o QR se desbloquea con la
// Password U de siempre; desde las 17 palabras se verifica contra el rol U on-chain, se define una Password U nueva, se
// prueba la posesión de U en el step-up KEY_RESTORE, se hacen los backups del sobre nuevo y se reemplaza el registro
// OPAQUE. Requiere la sesión de cuenta. La cámara sólo está permitida en esta ruta (Permissions-Policy del documento):
// los links hacia acá cargan el documento completo (`reloadDocument`).
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { StorageFlags } from '../api/wallet-api.ts';
import { api, argon2, walletFactory } from '../app/services.ts';
import { frontendClient, onchainRoles } from '../chain/roles.ts';
import { appConfig, systemContracts } from '../config/index.ts';
import { splitBackupWords } from '../crypto/backup-words.ts';
import { zeroize } from '../crypto/bytes.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { generatePassword } from '../crypto/password.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { BackupStep } from '../onboarding/BackupStep.tsx';
import { ConfirmPasswordWords, ShowPasswordWords } from '../onboarding/PasswordWords.tsx';
import { useSession, useSessionStore, useSensitiveScreen } from '../session/context.tsx';
import type { StepUpSession } from '../session/step-up.ts';
import { StepUpForm } from '../session/StepUpForm.tsx';
import { rememberEnvelope } from '../storage/envelope-cache.ts';
import { EnvelopeSource } from '../unlock/EnvelopeSource.tsx';
import { unlockWallet } from '../unlock/unlock.ts';
import { Field, formValue, Notice, useAsyncAction } from '../ui/forms.tsx';
import {
  commitRestore,
  finishKeyRestoreStepUp,
  keyFromWords,
  prepareRestoredEnvelope,
  type PreparedRestore,
} from './restore.ts';

type Mode = 'choose' | 'envelope' | 'words';
type WordsStep = 'enter' | 'password' | 'confirm' | 'step-up' | 'backups' | 'done';

export function RestorePage() {
  useSensitiveScreen();
  const { status, user, wallet } = useSession();
  const [mode, setMode] = useState<Mode>('choose');

  if (status !== 'account' || user === null) {
    return (
      <section className="stack narrow">
        <h1>Restaurar tu clave</h1>
        <Notice>
          Primero <Link to="/login">iniciá sesión</Link> con tu cuenta en este dispositivo.
        </Notice>
      </section>
    );
  }
  return (
    <section className="stack narrow" aria-labelledby="restore-title">
      <h1 id="restore-title">Restaurar tu clave en este dispositivo</h1>
      {mode === 'choose' && (
        <div className="choices" role="group" aria-label="Cómo restaurar">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setMode('envelope');
            }}
          >
            Con el sobre cifrado (Drive, archivo o QR) y mi Password U
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setMode('words');
            }}
          >
            Con las 17 palabras
          </button>
        </div>
      )}
      {mode === 'envelope' && <RestoreFromEnvelope />}
      {mode === 'words' && wallet !== null && (
        <RestoreFromWords userId={user.id} walletId={wallet.id} safe={wallet.safe} />
      )}
      {mode === 'words' && wallet === null && (
        <Notice tone="error">Tu cuenta no tiene una wallet para restaurar.</Notice>
      )}
    </section>
  );
}

function RestoreFromEnvelope() {
  const store = useSessionStore();
  const navigate = useNavigate();
  const [envelope, setEnvelope] = useState<KeyEnvelope | null>(null);
  const [remember, setRemember] = useState(true);
  const unlock = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        if (envelope === null) return;
        const unlocked = await unlockWallet(api, envelope, formValue(form, 'passwordU'), argon2);
        if (remember) await rememberEnvelope(envelope);
        store.unlocked(unlocked);
        await navigate('/', { replace: true });
      },
      [envelope, navigate, remember, store],
    ),
  );
  if (envelope === null) return <EnvelopeSource onEnvelope={setEnvelope} allowQr />;
  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        void unlock.run(event.currentTarget);
      }}
    >
      <p className="muted">
        Sobre de la clave <code>{envelope.keyAddress}</code>
      </p>
      <Field label="Password U" name="passwordU" type="password" autoComplete="off" spellCheck={false} required />
      <label className="check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => {
            setRemember(event.currentTarget.checked);
          }}
        />
        Recordar el sobre cifrado en este dispositivo
      </label>
      {unlock.error && (
        <p className="form__error" role="alert">
          {unlock.error}
        </p>
      )}
      <button type="submit" className="button" disabled={unlock.pending}>
        {unlock.pending ? 'Desbloqueando…' : 'Restaurar y desbloquear'}
      </button>
    </form>
  );
}

function RestoreFromWords({
  userId,
  walletId,
  safe,
}: {
  userId: string;
  walletId: string;
  safe: `0x${string}` | null;
}) {
  const store = useSessionStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<WordsStep>('enter');
  const [restored, setRestored] = useState<{ key: Uint8Array; address: `0x${string}` } | null>(null);
  const [passwordWords, setPasswordWords] = useState<string[] | null>(null);
  const [stepUp, setStepUp] = useState<StepUpSession | null>(null);
  const [prepared, setPrepared] = useState<PreparedRestore | null>(null);

  useEffect(
    () => () => {
      if (restored) zeroize(restored.key);
    },
    [restored],
  );

  const check = useAsyncAction(
    useCallback(
      async (form: HTMLFormElement) => {
        if (safe === null) throw new Error('Tu wallet todavía no tiene una Safe activa');
        const wordlist = await loadWordlist();
        const key = await keyFromWords(splitBackupWords(formValue(form, 'words')), wordlist, () =>
          onchainRoles(frontendClient(appConfig.rpcUrl), systemContracts.contracts, safe),
        );
        setRestored(key);
        setPasswordWords(generatePassword(wordlist));
        setStep('password');
      },
      [safe],
    ),
  );
  const prepare = useAsyncAction(
    useCallback(
      async (session: StepUpSession) => {
        if (!restored || !passwordWords) return;
        setPrepared(
          await prepareRestoredEnvelope(api, session, restored, passwordWords.join(' '), appConfig.platformId, argon2),
        );
        setStep('backups');
      },
      [passwordWords, restored],
    ),
  );
  const commit = useAsyncAction(
    useCallback(
      async (flags: StorageFlags) => {
        if (!stepUp || !prepared || !passwordWords) return;
        await commitRestore(api, stepUp, prepared, flags);
        await rememberEnvelope(prepared.envelope);
        if (restored) zeroize(restored.key);
        store.unlocked(await unlockWallet(api, prepared.envelope, passwordWords.join(' '), argon2));
        setStep('done');
      },
      [passwordWords, prepared, restored, stepUp, store],
    ),
  );

  return (
    <div className="stack">
      {step === 'enter' && (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void check.run(event.currentTarget);
          }}
        >
          <Notice tone="warning">
            Escribí las 17 palabras en orden. Sólo se acepta la clave U vigente de tu Safe.
          </Notice>
          <div className="field">
            <label htmlFor="restore-words" className="field__label">
              17 palabras
            </label>
            <textarea
              id="restore-words"
              name="words"
              className="field__input"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              required
            />
          </div>
          {check.error && (
            <p className="form__error" role="alert">
              {check.error}
            </p>
          )}
          <button type="submit" className="button" disabled={check.pending}>
            {check.pending ? 'Verificando…' : 'Verificar palabras'}
          </button>
        </form>
      )}
      {step === 'password' && passwordWords && (
        <>
          <Notice tone="success">
            Las palabras corresponden a la U vigente de tu Safe. Ahora elegimos una Password U nueva.
          </Notice>
          <ShowPasswordWords
            words={passwordWords}
            onWritten={() => {
              setStep('confirm');
            }}
          />
        </>
      )}
      {step === 'confirm' && passwordWords && (
        <ConfirmPasswordWords
          words={passwordWords}
          onConfirmed={() => {
            setStep('step-up');
          }}
          onBack={() => {
            setStep('password');
          }}
        />
      )}
      {step === 'step-up' && restored && (
        <>
          <StepUpForm
            scope="KEY_RESTORE"
            walletId={walletId}
            finish={(pending, codes) =>
              finishKeyRestoreStepUp(api, pending, codes, restored, { userId, walletId, walletFactory })
            }
            onSession={(session) => {
              setStepUp(session);
              void prepare.run(session);
            }}
          />
          {prepare.error && <Notice tone="error">{prepare.error}</Notice>}
        </>
      )}
      {step === 'backups' && prepared && restored && (
        <>
          <BackupStep
            envelope={prepared.envelope}
            initialFlags={{ words: true }}
            onDone={(flags) => void commit.run(flags)}
            continueLabel="Terminar la restauración"
          />
          {commit.error && <Notice tone="error">{commit.error}</Notice>}
        </>
      )}
      {step === 'done' && (
        <article className="card stack">
          <Notice tone="success">
            Tu clave quedó restaurada con la Password U nueva y la wallet está desbloqueada.
          </Notice>
          <button type="button" className="button" onClick={() => void navigate('/')}>
            Ir al inicio
          </button>
        </article>
      )}
    </div>
  );
}
