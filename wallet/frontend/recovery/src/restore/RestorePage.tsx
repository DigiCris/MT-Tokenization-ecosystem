// `/restore` (P19.T08, [F-KEY-10]): R en un dispositivo nuevo, o en éste si sólo quedan las 17 palabras (el desbloqueo
// de las otras pantallas pide un sobre: cuarta revisión de P17.MAN, hallazgo 6). El sobre `R.enc` sale del Drive de
// Recovery, de un archivo o del QR (cámara permitida en esta ruta) y se abre con la Password R; o R sale de las 17
// palabras y se re-cifra con una Password R nueva para la wallet de la PlatformSession RECOVERY (su papel lleva la
// dirección de R, que ya se conoce). Antes de quedarse con R, la app verifica en Base que sea la recoveryKey vigente de
// la Safe y uno de sus owners. Después se puede recordar el sobre en este dispositivo y guardar los backups (Drive,
// archivo o QR, con la dirección de R en el nombre y en lo impreso). En Drive hay un sobre por clave (N13 de la
// verificación de P17.MAN: en un reemplazo conviven el de la R vigente y el de R′), así que la lista muestra la
// dirección de la R de cada uno, leída de su contenido y comparada con la de su nombre.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { argon2, pinned, reader } from '../app/services.ts';
import { LoginForm } from '../auth/LoginForm.tsx';
import { NewPasswordR } from '../backup/NewPasswordR.tsx';
import { parseAddressInput } from '../chain/address.ts';
import { appConfig } from '../config/index.ts';
import { wipe } from '../crypto/encoding.ts';
import {
  envelopeFileName,
  openRecoveryEnvelope,
  parseRecoveryEnvelope,
  serializeRecoveryEnvelope,
  type RecoveryEnvelope,
} from '../crypto/envelope.ts';
import { normalizePasswordR } from '../crypto/password.ts';
import type { UnlockedRecovery } from '../crypto/session.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { listRecoveryBackups, uploadRecoveryEnvelope, type RecoveryBackup } from '../drive/backup.ts';
import { DriveClient } from '../drive/client.ts';
import { DriveConnect } from '../drive/DriveConnect.tsx';
import { driveToken, hasDriveToken } from '../drive/token.ts';
import { encodeFrames, FrameCollector, type FrameProgress } from '../qr/frames.ts';
import { useSensitiveScreen, useSession, useSessionStore } from '../session/context.tsx';
import { StepUp } from '../session/StepUp.tsx';
import { rememberedSafe, rememberEnvelope, rememberSafe } from '../storage/envelope-cache.ts';
import { AddressText, groupedAddress } from '../ui/AddressText.tsx';
import { downloadText, readTextFile } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Field, formValue, Notice, TextAreaField, useAsyncAction } from '../ui/forms.tsx';
import { QrScanner } from '../ui/QrScanner.tsx';
import { EnvelopeQr } from '../backup/EnvelopeQr.tsx';
import { recoveryFromWords, resealRecovery, verifyRestoredRecovery, type WordsRecovery } from './restore.ts';

type Source = 'drive' | 'file' | 'qr' | 'words';

const drive = new DriveClient(() => driveToken());

/** Archivos de la carpeta de Recovery que no son un sobre de R válido (o no coinciden con su nombre): no se ofrecen. */
function unreadableText(count: number): string {
  return count === 1
    ? 'Un archivo de tu Drive de Recovery no es un sobre de R válido o no coincide con su nombre: no se muestra.'
    : `${String(count)} archivos de tu Drive de Recovery no son sobres de R válidos o no coinciden con su nombre: no se muestran.`;
}

function Restored({ unlocked, fromWords }: { unlocked: UnlockedRecovery; fromWords: boolean }) {
  const [remembered, setRemembered] = useState(false);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const remember = useAsyncAction(
    useCallback(async () => {
      await rememberEnvelope(unlocked.envelope);
      setRemembered(true);
    }, [unlocked]),
  );
  const upload = useAsyncAction(
    useCallback(async () => {
      await uploadRecoveryEnvelope(drive, unlocked.envelope);
      setUploaded(true);
    }, [unlocked]),
  );
  const showQr = useAsyncAction(
    useCallback(async () => {
      setFrames(await encodeFrames(JSON.stringify(unlocked.envelope)));
    }, [unlocked]),
  );
  return (
    <section className="card stack" aria-labelledby="restored-title" data-restored={unlocked.address}>
      <h2 id="restored-title">Tu clave R quedó restaurada</h2>
      <Notice tone="success">
        Es la clave de recuperación vigente de tu Safe en Base (dirección <AddressText address={unlocked.address} />) y
        quedó desbloqueada en esta pestaña.
      </Notice>
      {fromWords && (
        <Notice tone="warning">
          Es un sobre nuevo, cifrado con tu Password R nueva: guardá al menos un backup (archivo o QR) antes de seguir.
        </Notice>
      )}
      <div className="actions">
        {remembered ? (
          <Notice tone="success">Sobre cifrado recordado en este dispositivo.</Notice>
        ) : (
          <button
            type="button"
            className="button button--secondary"
            disabled={remember.pending}
            onClick={() => void remember.run()}
          >
            Recordar el sobre cifrado en este dispositivo
          </button>
        )}
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            downloadText(envelopeFileName(unlocked.envelope), serializeRecoveryEnvelope(unlocked.envelope));
          }}
        >
          Descargar el archivo cifrado
        </button>
        {frames === null && (
          <button type="button" className="button button--secondary" onClick={() => void showQr.run()}>
            Mostrar el QR del sobre
          </button>
        )}
        {hasDriveToken() &&
          (uploaded ? (
            <Notice tone="success">Sobre guardado en tu Drive de Recovery.</Notice>
          ) : (
            <button
              type="button"
              className="button button--secondary"
              disabled={upload.pending}
              onClick={() => void upload.run()}
            >
              Guardar el sobre en mi Drive
            </button>
          ))}
      </div>
      {frames && <EnvelopeQr frames={frames} keyAddress={unlocked.address} printId="restored-qr-print" />}
      {(remember.error ?? upload.error ?? showQr.error) && (
        <Notice tone="error">{remember.error ?? upload.error ?? showQr.error}</Notice>
      )}
    </section>
  );
}

/** La Safe contra la que se verifica R: la de la PlatformSession, la recordada para esa R o la que escribe el usuario. */
function SafeForCheck({
  recoveryKey,
  sessionSafe,
  onSafe,
}: {
  recoveryKey: Address;
  sessionSafe: Address | null;
  onSafe: (safe: Address) => void;
}) {
  const [value, setValue] = useState(sessionSafe ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sessionSafe !== null) return;
    let alive = true;
    rememberedSafe(recoveryKey)
      .then((safe) => {
        if (alive && safe !== null) setValue((current) => (current === '' ? safe : current));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [recoveryKey, sessionSafe]);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          setError(null);
          onSafe(parseAddressInput(formValue(event.currentTarget, 'safe')));
        } catch (caught) {
          setError(describeError(caught));
        }
      }}
    >
      <Field
        label="Dirección de tu Safe (para verificar R en Base)"
        name="safe"
        autoComplete="off"
        spellCheck={false}
        required
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" className="button">
        Verificar en Base
      </button>
    </form>
  );
}

export function RestorePage() {
  useSensitiveScreen();
  const session = useSession();
  const store = useSessionStore();
  const [source, setSource] = useState<Source | null>(hasDriveToken() ? 'drive' : null);
  const [envelope, setEnvelope] = useState<RecoveryEnvelope | null>(null);
  const [opened, setOpened] = useState<UnlockedRecovery | null>(null);
  const [fromWords, setFromWords] = useState<WordsRecovery | null>(null);
  const [restored, setRestored] = useState<{ unlocked: UnlockedRecovery; fromWords: boolean } | null>(null);
  const [backups, setBackups] = useState<{ backups: RecoveryBackup[]; unreadable: number } | null>(null);
  const [scanning, setScanning] = useState<FrameCollector | null>(null);
  const [progress, setProgress] = useState<FrameProgress | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const platform = session.platform?.view.scope === 'RECOVERY' ? session.platform : null;

  // R en claro (de las palabras) no sobrevive al desmontar la pantalla.
  useEffect(
    () => () => {
      if (fromWords) wipe(fromWords.key);
    },
    [fromWords],
  );

  const choose = useCallback((value: unknown) => {
    try {
      setSourceError(null);
      setEnvelope(parseRecoveryEnvelope(value));
    } catch (caught) {
      setSourceError(describeError(caught));
    }
  }, []);

  // Cada sobre ya viene leído y validado contra su nombre (drive/backup.ts): elegirlo no vuelve a descargar nada.
  const listDrive = useAsyncAction(
    useCallback(async () => {
      setBackups(await listRecoveryBackups(drive));
    }, []),
  );

  const onQrText = useCallback(
    (text: string) => {
      if (!scanning) return;
      const step = scanning.add(text);
      if (step) setProgress(step);
      void scanning
        .content()
        .then((content) => {
          if (content === null) return;
          setScanning(null);
          choose(JSON.parse(content));
        })
        .catch((caught: unknown) => {
          setSourceError(describeError(caught));
        });
    },
    [scanning, choose],
  );

  const open = useAsyncAction(
    useCallback(
      async (password: string) => {
        if (!envelope) return;
        const wordlist = await loadWordlist();
        setOpened(await openRecoveryEnvelope(envelope, normalizePasswordR(password, wordlist), argon2));
      },
      [envelope],
    ),
  );

  const readWords = useAsyncAction(
    useCallback(async (text: string) => {
      setFromWords(await recoveryFromWords(text, await loadWordlist()));
    }, []),
  );

  const verifyOpened = useAsyncAction(
    useCallback(
      async (safe: Address) => {
        if (!opened) return;
        await verifyRestoredRecovery(reader, pinned.system.contracts.guard.address, safe, opened.address);
        await rememberSafe(opened.address, safe).catch(() => undefined);
        store.unlockRecovery(opened);
        setRestored({ unlocked: opened, fromWords: false });
      },
      [opened, store],
    ),
  );

  const reseal = useAsyncAction(
    useCallback(
      async (words: string[]) => {
        if (!fromWords || !platform?.view.walletId || !platform.view.safe) return;
        const safe = platform.view.safe;
        await verifyRestoredRecovery(reader, pinned.system.contracts.guard.address, safe, fromWords.address);
        const sealed = await resealRecovery(
          fromWords.key,
          words,
          { platformId: appConfig.platformId, walletId: platform.view.walletId },
          argon2,
        );
        wipe(fromWords.key);
        await rememberSafe(sealed.address, safe).catch(() => undefined);
        store.unlockRecovery(sealed);
        setFromWords(null);
        setRestored({ unlocked: sealed, fromWords: true });
      },
      [fromWords, platform, store],
    ),
  );

  if (restored) return <Restored unlocked={restored.unlocked} fromWords={restored.fromWords} />;

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="restore-title">
        <h1 id="restore-title">Restaurar tu clave de recuperación (R)</h1>
        <p>
          En un dispositivo nuevo o en éste: desde tu Drive de Recovery, el archivo cifrado, el QR del sobre o las 17
          palabras.
        </p>
        {envelope === null && fromWords === null && (
          <div className="actions">
            {(['drive', 'file', 'qr', 'words'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="button button--secondary"
                aria-pressed={source === value}
                onClick={() => {
                  setSource(value);
                  setSourceError(null);
                }}
              >
                {
                  {
                    drive: 'Google Drive de Recovery',
                    file: 'Archivo cifrado',
                    qr: 'QR del sobre',
                    words: '17 palabras',
                  }[value]
                }
              </button>
            ))}
          </div>
        )}
        {sourceError && <Notice tone="error">{sourceError}</Notice>}
      </section>

      {envelope === null && fromWords === null && source === 'drive' && (
        <section className="card stack" aria-labelledby="restore-drive-title">
          <h2 id="restore-drive-title">Tu Drive de Recovery</h2>
          <DriveConnect returnTo="/restore">
            Conectá la cuenta de Google donde guardaste el sobre cifrado de R (carpeta privada de Recovery).
          </DriveConnect>
          {hasDriveToken() && backups === null && (
            <button type="button" className="button" disabled={listDrive.pending} onClick={() => void listDrive.run()}>
              Buscar mis sobres en Drive
            </button>
          )}
          {backups?.backups.length === 0 && <Notice tone="warning">No hay sobres de R en este Drive.</Notice>}
          {backups !== null && backups.unreadable > 0 && (
            <Notice tone="warning">{unreadableText(backups.unreadable)}</Notice>
          )}
          <ul className="list">
            {backups?.backups.map((backup) => (
              <li key={backup.file.id} data-drive-backup={backup.walletId} data-drive-backup-key={backup.keyAddress}>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    setEnvelope(backup.envelope);
                  }}
                >
                  Sobre de la clave R con la dirección <code>{groupedAddress(backup.keyAddress)}</code>, de la wallet{' '}
                  {backup.walletId.slice(0, 8)}…
                  {backup.file.modifiedTime ? ` (${new Date(backup.file.modifiedTime).toLocaleString('es-AR')})` : ''}
                </button>
              </li>
            ))}
          </ul>
          {listDrive.error && <Notice tone="error">{listDrive.error}</Notice>}
        </section>
      )}

      {envelope === null && fromWords === null && source === 'file' && (
        <section className="card stack" aria-labelledby="restore-file-title">
          <h2 id="restore-file-title">Archivo cifrado</h2>
          <label className="field">
            <span className="field__label">Archivo del sobre cifrado (R.enc)</span>
            <input
              type="file"
              accept="application/json,.json"
              className="field__input"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) {
                  void readTextFile(file).then((text) => {
                    try {
                      choose(JSON.parse(text));
                    } catch {
                      setSourceError('El archivo no es un sobre cifrado de MT Wallet.');
                    }
                  });
                }
              }}
            />
          </label>
        </section>
      )}

      {envelope === null && fromWords === null && source === 'qr' && (
        <section className="card stack" aria-labelledby="restore-qr-title">
          <h2 id="restore-qr-title">QR del sobre</h2>
          {scanning === null ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                setScanning(new FrameCollector());
                setProgress(null);
              }}
            >
              Leer el QR con la cámara
            </button>
          ) : (
            <QrScanner onText={onQrText} />
          )}
          {progress && (
            <p className="muted">
              Cuadros leídos: {progress.received} de {progress.total}
            </p>
          )}
        </section>
      )}

      {envelope === null && fromWords === null && source === 'words' && (
        <section className="card stack" aria-labelledby="restore-words-title">
          <h2 id="restore-words-title">Las 17 palabras de R</h2>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void readWords.run(formValue(event.currentTarget, 'words'));
            }}
          >
            <TextAreaField
              label="Las 17 palabras, en orden"
              name="words"
              rows={4}
              autoComplete="off"
              spellCheck={false}
              required
            />
            {readWords.error && <Notice tone="error">{readWords.error}</Notice>}
            <button type="submit" className="button" disabled={readWords.pending}>
              Leer las palabras
            </button>
          </form>
        </section>
      )}

      {envelope && !opened && (
        <section className="card stack" aria-labelledby="restore-open-title">
          <h2 id="restore-open-title">Abrí el sobre</h2>
          <p>
            Sobre cifrado de la clave R con la dirección <AddressText address={envelope.keyAddress} />
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void open.run(formValue(event.currentTarget, 'passwordR'));
            }}
          >
            <Field label="Password R" name="passwordR" type="password" autoComplete="off" required />
            {open.error && <Notice tone="error">{open.error}</Notice>}
            <button type="submit" className="button" disabled={open.pending}>
              {open.pending ? 'Abriendo el sobre…' : 'Abrir el sobre'}
            </button>
          </form>
        </section>
      )}

      {opened && (
        <section className="card stack" aria-labelledby="restore-check-title">
          <h2 id="restore-check-title">Verificar R en Base</h2>
          <SafeForCheck
            recoveryKey={opened.address}
            sessionSafe={platform?.view.walletId === opened.envelope.walletId ? platform.view.safe : null}
            onSafe={(safe) => void verifyOpened.run(safe)}
          />
          {verifyOpened.error && <Notice tone="error">{verifyOpened.error}</Notice>}
        </section>
      )}

      {fromWords && (
        <section className="card stack" aria-labelledby="restore-reseal-title">
          <h2 id="restore-reseal-title">Clave R desde las palabras</h2>
          <p>
            Dirección de la clave R: <AddressText address={fromWords.address} />
          </p>
          {session.status !== 'account' ? (
            <>
              <p>Para cifrarla de nuevo, iniciá sesión con tu cuenta (la wallet sale de tu cuenta).</p>
              <LoginForm onSignedIn={() => undefined} />
            </>
          ) : platform === null ? (
            <StepUp scope="RECOVERY" />
          ) : platform.view.safe === null ? (
            <Notice tone="error">Tu wallet todavía no tiene una Safe activa.</Notice>
          ) : (
            <NewPasswordR
              generateLabel="Generar la Password R nueva"
              confirmLabel="Verificar en Base y cifrar"
              pending={reseal.pending}
              error={reseal.error}
              keyAddress={fromWords.address}
              onConfirmed={(words) => void reseal.run(words)}
            />
          )}
        </section>
      )}
    </div>
  );
}
