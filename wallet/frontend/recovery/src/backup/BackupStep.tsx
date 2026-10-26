// Backups de R ([F-KEY-06]): antes de enviar el enrollment, R necesita al menos un backup que no dependa de la
// plataforma —el archivo cifrado, el QR del sobre o las 17 palabras—, porque la salida soberana tiene que funcionar
// aunque la plataforma desaparezca. El Drive de Recovery (si se conectó antes de crear R: la redirección de Google no
// conserva lo que está en memoria) suma comodidad pero no cuenta como independiente: su cliente OAuth es de la
// plataforma. Lo que se dice de cada backup tiene que ser cierto también sin la plataforma: R sola no mueve fondos (la
// Safe pide 2 de 3 firmas), así que para eso hace falta además U. El QR del sobre son cuadros quietos (todos a la vista
// y para imprimir) y las 17 palabras cuentan como backup recién cuando el usuario reingresa 3 al azar: hasta entonces
// puede volver a verlas o imprimirlas solas, y mientras están a la vista sin confirmar no se puede seguir (después de
// este paso no se vuelven a mostrar). Cada backup hecho y confirmado queda en los storageFlags del enrollment. Lo que se
// imprime lleva el título de qué app y qué clave es, y los backups de R se guardan lejos de los de U: las dos juntas
// mueven los fondos sin la plataforma (tercera revisión de P17.MAN). El archivo, lo impreso y lo anotado llevan la
// dirección de esta R (abreviada), para distinguir sus backups de los de otra R (cuarta revisión, hallazgo 1).
import { useCallback, useEffect, useState } from 'react';
import type { StorageFlags } from '../api/recovery-api.ts';
import { uploadRecoveryEnvelope } from '../drive/backup.ts';
import { DriveClient } from '../drive/client.ts';
import { driveToken, hasDriveToken } from '../drive/token.ts';
import { BACKUP_WORDS, recoveryKeyToWords } from '../crypto/backup-words.ts';
import { envelopeFileName, serializeRecoveryEnvelope } from '../crypto/envelope.ts';
import { BACKUP_CONFIRMATION_WORDS, confirmsPassword, randomPositions } from '../crypto/password.ts';
import { withRecoveryKey, type UnlockedRecovery } from '../crypto/session.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { encodeFrames } from '../qr/frames.ts';
import { downloadText } from '../ui/download.ts';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { printSection } from '../ui/print.ts';
import { EnvelopeQr } from './EnvelopeQr.tsx';
import { R_APART_FROM_U_WARNING, R_BACKUP_INTRO, rWordsHandwritten, rWordsTitle } from './texts.ts';

export function BackupStep({
  unlocked,
  onDone,
}: {
  unlocked: UnlockedRecovery;
  onDone: (flags: StorageFlags) => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [flags, setFlags] = useState<StorageFlags>({ drive: false, file: false, qr: false, words: false });
  // Las 17 palabras a la vista (o en su confirmación) sin confirmar: si se sigue, ya no se ven.
  const [wordsOpen, setWordsOpen] = useState(false);
  const independent = flags.file || flags.qr || flags.words;

  const showQr = useAsyncAction(async () => {
    setFrames(await encodeFrames(JSON.stringify(unlocked.envelope)));
  });
  const saveToDrive = useAsyncAction(async () => {
    await uploadRecoveryEnvelope(new DriveClient(() => driveToken()), unlocked.envelope);
    setFlags((f) => ({ ...f, drive: true }));
  });
  const check = (name: keyof StorageFlags) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setFlags((f) => ({ ...f, [name]: value }));
  };

  return (
    <section className="card stack" aria-labelledby="backup-title">
      <h2 id="backup-title">Backups de tu clave R</h2>
      <p>{R_BACKUP_INTRO}</p>
      <Notice tone="warning">{R_APART_FROM_U_WARNING}</Notice>

      {hasDriveToken() && (
        <div className="stack">
          <h3>Google Drive de Recovery</h3>
          <p className="muted">
            Es un backup adicional: guarda el sobre cifrado en la carpeta privada de Recovery en tu Drive, pero depende
            de la plataforma y no reemplaza al archivo, al QR ni a las 17 palabras.
          </p>
          {flags.drive ? (
            <Notice tone="success">El sobre cifrado quedó en la carpeta privada de Recovery en tu Drive.</Notice>
          ) : (
            <button
              type="button"
              className="button button--secondary"
              disabled={saveToDrive.pending}
              onClick={() => void saveToDrive.run()}
            >
              {saveToDrive.pending ? 'Guardando en Drive…' : 'Guardar el sobre cifrado en mi Drive'}
            </button>
          )}
          {saveToDrive.error && <Notice tone="error">{saveToDrive.error}</Notice>}
        </div>
      )}

      <div className="stack">
        <h3>Archivo cifrado</h3>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            downloadText(envelopeFileName(unlocked.envelope), serializeRecoveryEnvelope(unlocked.envelope));
            setDownloaded(true);
          }}
        >
          Descargar el archivo cifrado
        </button>
        <label className="check">
          <input type="checkbox" disabled={!downloaded} checked={flags.file} onChange={check('file')} /> Guardé el
          archivo fuera de este dispositivo (sin la Password R al lado).
        </label>
      </div>

      <div className="stack">
        <h3>QR del sobre cifrado</h3>
        {frames === null ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={showQr.pending}
            onClick={() => void showQr.run()}
          >
            Mostrar el QR
          </button>
        ) : (
          <>
            <EnvelopeQr frames={frames} keyAddress={unlocked.address} printId="r-qr-print" />
            <label className="check">
              <input type="checkbox" checked={flags.qr} onChange={check('qr')} />{' '}
              {frames.length > 1
                ? `Guardé o imprimí las ${String(frames.length)} partes del QR fuera de este dispositivo (sin la Password R al lado).`
                : 'Guardé o imprimí el QR fuera de este dispositivo (sin la Password R al lado).'}
            </label>
          </>
        )}
        {showQr.error && <Notice tone="error">{showQr.error}</Notice>}
      </div>

      <BackupWords
        unlocked={unlocked}
        onOpenChange={setWordsOpen}
        onConfirmed={() => {
          setFlags((f) => ({ ...f, words: true }));
        }}
      />

      {!independent && <Notice tone="warning">Falta al menos un backup: archivo, QR o las 17 palabras.</Notice>}
      {wordsOpen && (
        <Notice tone="warning">
          Antes de seguir, confirmá las 17 palabras u ocultalas: después de este paso no se vuelven a mostrar.
        </Notice>
      )}
      <button
        type="button"
        className="button"
        disabled={!independent || wordsOpen}
        onClick={() => {
          onDone(flags);
        }}
      >
        Continuar
      </button>
    </section>
  );
}

type WordsStep = 'hidden' | 'shown' | 'confirm' | 'confirmed';

/**
 * Las 17 palabras de R ([F-KEY-06].4): se muestran sólo en este paso y quedan como backup recién cuando el usuario
 * reingresa 3 al azar (marcar una casilla no las oculta ni las da por anotadas: hasta confirmar se pueden volver a
 * ver). Se imprimen solas, sin el resto de la página. Al confirmarlas u ocultarlas se borran de la memoria.
 */
function BackupWords({
  unlocked,
  onOpenChange,
  onConfirmed,
}: {
  unlocked: UnlockedRecovery;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
}) {
  const [step, setStep] = useState<WordsStep>('hidden');
  const [words, setWords] = useState<string[] | null>(null);
  const [written, setWritten] = useState(false);
  // Posiciones nuevas cada vez que se pasa a confirmar.
  const [positions, setPositions] = useState<number[]>([]);
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const show = useAsyncAction(
    useCallback(async () => {
      const wordlist = await loadWordlist();
      setWords(await withRecoveryKey(unlocked, (key) => recoveryKeyToWords(key, wordlist)));
      setWritten(false);
      setStep('shown');
    }, [unlocked]),
  );
  useEffect(() => {
    onOpenChange(step === 'shown' || step === 'confirm');
  }, [step, onOpenChange]);
  useEffect(
    () => () => {
      setWords(null);
    },
    [],
  );

  return (
    <div className="stack">
      <h3>17 palabras</h3>
      <Notice tone="warning">
        Las 17 palabras son la clave R misma: quien las tenga controla R sin necesitar la Password R. Se muestran sólo
        en este paso: anotalas en papel, en orden, y guardalas lejos de la Password R y de los backups de tu clave U.
        Están en inglés: copialas letra por letra, sin traducir ni corregir.
      </Notice>
      {step === 'hidden' && (
        <button
          type="button"
          className="button button--secondary"
          disabled={show.pending}
          onClick={() => void show.run()}
        >
          Mostrar las 17 palabras
        </button>
      )}
      {step === 'shown' && words !== null && (
        <>
          <div className="stack" id="r-words-print">
            <p className="print-title">{rWordsTitle(unlocked.address)}</p>
            <ol className="words words--17" aria-label="17 palabras de tu clave R">
              {words.map((word, i) => (
                <li key={`${String(i)}-${word}`} className="words__item">
                  <span className="words__index">{i + 1}</span> <span className="words__word">{word}</span>
                </li>
              ))}
            </ol>
          </div>
          <p>{rWordsHandwritten(unlocked.address)}</p>
          <div className="actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                printSection('r-words-print');
              }}
            >
              Imprimir sólo las palabras
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setWords(null);
                setStep('hidden');
              }}
            >
              Ocultar las palabras
            </button>
          </div>
          <p className="muted">Si las imprimís, usá una impresora de confianza y no guardes el PDF.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={written}
              onChange={(event) => {
                setWritten(event.currentTarget.checked);
              }}
            />{' '}
            Anoté las 17 palabras en orden y las guardo fuera de este dispositivo.
          </label>
          <button
            type="button"
            className="button"
            disabled={!written}
            onClick={() => {
              setError(null);
              setTyped({});
              setPositions(randomPositions(BACKUP_WORDS, BACKUP_CONFIRMATION_WORDS));
              setStep('confirm');
            }}
          >
            Ya las anoté
          </button>
        </>
      )}
      {step === 'confirm' && words !== null && (
        <form
          className="stack"
          aria-labelledby="confirm-r-words"
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmsPassword(words, typed, positions)) {
              setError('Alguna palabra no coincide: revisá lo que anotaste.');
              return;
            }
            setWords(null);
            setStep('confirmed');
            onConfirmed();
          }}
        >
          <p id="confirm-r-words">
            Para comprobar que las anotaste bien, escribí estas {BACKUP_CONFIRMATION_WORDS} palabras de tu papel.
          </p>
          {positions.map((p) => (
            <Field
              key={p}
              label={`Palabra ${String(p + 1)} de ${String(BACKUP_WORDS)}`}
              name={`backup-word-${String(p)}`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={typed[p] ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setTyped((current) => ({ ...current, [p]: value }));
              }}
            />
          ))}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="actions">
            <button type="submit" className="button">
              Confirmar las palabras
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setStep('shown');
              }}
            >
              Volver a ver las palabras
            </button>
          </div>
        </form>
      )}
      {step === 'confirmed' && <Notice tone="success">Palabras anotadas y confirmadas.</Notice>}
      {show.error && <Notice tone="error">{show.error}</Notice>}
    </div>
  );
}
