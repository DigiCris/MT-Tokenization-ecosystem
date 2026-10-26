// Backups del sobre de U ([F-KEY-06]): Drive (adicional, verificado byte a byte después de subir), archivo cifrado,
// QR del sobre (canvas; si son varias partes hacen falta todas) y las 17 palabras (sólo en este paso, con opción de
// imprimir sin otros datos). Las 17 palabras cuentan como backup recién cuando el usuario reingresa 3 al azar: hasta
// entonces puede volver a verlas, y después se borran de la memoria. Hace falta al menos un backup que no dependa de la
// plataforma (archivo, QR o palabras) para seguir, y no se sigue con las palabras a la vista sin confirmar (después de
// este paso no se vuelven a mostrar): hay que confirmarlas u ocultarlas. Lo que se imprime lleva el título de qué app y
// qué clave es, y las 17 palabras se guardan lejos de los backups de R: U y R juntas mueven los fondos sin la
// plataforma (tercera revisión de P17.MAN). El archivo, lo impreso y lo anotado llevan la dirección de esta U
// (abreviada): los backups de U′ se distinguen de los de la U anterior (cuarta revisión, hallazgo 1).
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { StorageFlags } from '../api/wallet-api.ts';
import { drive } from '../app/services.ts';
import { BACKUP_WORDS, keyToBackupWords } from '../crypto/backup-words.ts';
import { serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { confirmationMatches, randomPositions } from '../crypto/password.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { uploadEnvelope } from '../drive/backup.ts';
import { hasDriveToken } from '../drive/token.ts';
import { encodeFrames } from '../qr/frames.ts';
import { downloadText, envelopeFileName } from '../ui/download.ts';
import { Field, Notice, useAsyncAction } from '../ui/forms.tsx';
import { printSection } from '../ui/print.ts';
import { EnvelopeQr } from './EnvelopeQr.tsx';
import { hasIndependentBackup, LOST_U_AND_R_WARNING, uWordsHandwritten, uWordsTitle } from './user-key.ts';

/** Palabras que se reingresan para confirmar el backup de 17 (como las 2 de la Password U). */
const WORDS_TO_CONFIRM = 3;

export function BackupStep({
  envelope,
  wordsKey,
  initialFlags,
  onDone,
  continueLabel = 'Continuar',
}: {
  envelope: KeyEnvelope;
  /** Sólo si la clave está en memoria en este flujo (alta, restauración por palabras, U'). */
  wordsKey?: Uint8Array;
  /** Backups que ya existen (p. ej. las 17 palabras con las que se restauró la misma U). */
  initialFlags?: Partial<StorageFlags>;
  onDone: (flags: StorageFlags) => void;
  continueLabel?: string;
}) {
  const [flags, setFlags] = useState<StorageFlags>({
    drive: false,
    file: false,
    qr: false,
    words: false,
    ...initialFlags,
  });
  const [downloaded, setDownloaded] = useState(false);
  const [frames, setFrames] = useState<string[] | null>(null);
  // Las 17 palabras a la vista (o en su confirmación) sin confirmar: si se sigue, ya no se ven.
  const [wordsOpen, setWordsOpen] = useState(false);
  const driveConnected = hasDriveToken();

  const upload = useAsyncAction(
    useCallback(async () => {
      await uploadEnvelope(drive, envelope);
      setFlags((f) => ({ ...f, drive: true }));
    }, [envelope]),
  );
  const showQr = useAsyncAction(
    useCallback(async () => {
      setFrames(await encodeFrames(JSON.stringify(envelope)));
    }, [envelope]),
  );

  const check = (name: keyof StorageFlags) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setFlags((f) => ({ ...f, [name]: value }));
  };

  return (
    <div className="stack" aria-label="Backups de la clave">
      <Notice tone="warning">{LOST_U_AND_R_WARNING}</Notice>

      <article className="card stack" aria-labelledby="backup-drive">
        <h2 id="backup-drive">Google Drive</h2>
        <p>
          Se guarda el sobre cifrado en la carpeta privada de la app en tu Drive y se verifica que haya quedado igual.
        </p>
        {driveConnected ? (
          flags.drive ? (
            <Notice tone="success">Sobre subido a Drive y verificado.</Notice>
          ) : (
            <>
              {upload.error && <Notice tone="error">{upload.error}</Notice>}
              <button
                type="button"
                className="button"
                disabled={upload.pending}
                aria-busy={upload.pending}
                onClick={() => void upload.run()}
              >
                {upload.pending ? 'Subiendo y verificando…' : 'Subir a Drive y verificar'}
              </button>
            </>
          )
        ) : (
          <Notice>Drive no está conectado en esta sesión: este backup queda pendiente.</Notice>
        )}
      </article>

      <Notice tone="warning">
        Necesitás al menos un backup que no dependa de MT Wallet (archivo, QR o las 17 palabras): si la plataforma o tu
        acceso a Drive desaparecen, con él igual recuperás tu clave U. El archivo y el QR sólo se abren con tu Password
        U; las 17 palabras no la necesitan. Sin la plataforma, para mover tus fondos también vas a necesitar tu clave R.
      </Notice>
      {initialFlags?.words === true && !wordsKey && (
        <Notice tone="success">Tus 17 palabras siguen siendo un backup válido de esta misma clave.</Notice>
      )}

      <article className="card stack" aria-labelledby="backup-file">
        <h2 id="backup-file">Archivo cifrado</h2>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            downloadText(envelopeFileName(envelope), serializeEnvelope(envelope));
            setDownloaded(true);
          }}
        >
          Descargar el archivo cifrado
        </button>
        <label className="check">
          <input type="checkbox" disabled={!downloaded} checked={flags.file} onChange={check('file')} />
          Guardé el archivo fuera de este dispositivo (sin la Password U al lado).
        </label>
      </article>

      <article className="card stack" aria-labelledby="backup-qr">
        <h2 id="backup-qr">QR del sobre cifrado</h2>
        {frames === null ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={showQr.pending}
            aria-busy={showQr.pending}
            onClick={() => void showQr.run()}
          >
            Mostrar QR
          </button>
        ) : (
          <>
            <EnvelopeQr frames={frames} keyAddress={envelope.keyAddress} printId="qr-print" />
            <label className="check">
              <input type="checkbox" checked={flags.qr} onChange={check('qr')} />
              {frames.length > 1
                ? `Guardé o imprimí las ${String(frames.length)} partes del QR fuera de este dispositivo (sin la Password U al lado).`
                : 'Guardé o imprimí el QR fuera de este dispositivo (sin la Password U al lado).'}
            </label>
          </>
        )}
        {showQr.error && <Notice tone="error">{showQr.error}</Notice>}
      </article>

      {wordsKey && (
        <BackupWords
          wordsKey={wordsKey}
          keyAddress={envelope.keyAddress}
          onOpenChange={setWordsOpen}
          onConfirmed={() => {
            setFlags((f) => ({ ...f, words: true }));
          }}
        />
      )}

      {wordsOpen && (
        <Notice tone="warning">
          Antes de seguir, confirmá las 17 palabras u ocultalas: después de este paso no se vuelven a mostrar.
        </Notice>
      )}
      <button
        type="button"
        className="button"
        disabled={!hasIndependentBackup(flags) || wordsOpen}
        onClick={() => {
          onDone(flags);
        }}
      >
        {continueLabel}
      </button>
    </div>
  );
}

type WordsStep = 'hidden' | 'shown' | 'confirm' | 'confirmed';

/**
 * Las 17 palabras ([F-KEY-06].4): se muestran sólo en este paso y quedan como backup recién cuando el usuario reingresa
 * 3 palabras al azar (un clic de más no las pierde: hasta confirmar se pueden volver a ver). Al confirmarlas u
 * ocultarlas se borran de la memoria; mientras están a la vista sin confirmar, el paso no deja seguir (`onOpenChange`).
 */
function BackupWords({
  wordsKey,
  keyAddress,
  onOpenChange,
  onConfirmed,
}: {
  wordsKey: Uint8Array;
  /** La dirección de la clave: va abreviada en el título de lo impreso y de lo anotado. */
  keyAddress: Address;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
}) {
  const [step, setStep] = useState<WordsStep>('hidden');
  const [words, setWords] = useState<string[] | null>(null);
  const [written, setWritten] = useState(false);
  // Posiciones nuevas cada vez que se pasa a confirmar.
  const [positions, setPositions] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const show = useAsyncAction(
    useCallback(async () => {
      setWords(await keyToBackupWords('U', wordsKey, await loadWordlist()));
      setWritten(false);
      setStep('shown');
    }, [wordsKey]),
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
    <article className="card stack" aria-labelledby="backup-words">
      <h2 id="backup-words">17 palabras de la clave</h2>
      <Notice tone="warning">
        Las 17 palabras son la clave misma: quien las tenga controla la clave sin necesitar la Password U. Se muestran
        sólo en este paso: anotalas en papel, en orden, y guardalas lejos de la Password U y de los backups de tu clave
        R: quien junte tu clave U y tu clave R puede mover tus fondos sin la plataforma. Están en inglés: copialas letra
        por letra, sin traducir ni corregir.
      </Notice>
      {step === 'hidden' && (
        <button
          type="button"
          className="button button--ghost"
          disabled={show.pending}
          aria-busy={show.pending}
          onClick={() => void show.run()}
        >
          Mostrar las 17 palabras
        </button>
      )}
      {step === 'shown' && words !== null && (
        <>
          <div className="stack" id="words-print">
            <p className="print-title">{uWordsTitle(keyAddress)}</p>
            <ol className="words words--17" aria-label="17 palabras de la clave">
              {words.map((word, i) => (
                <li key={`${String(i)}-${word}`} className="words__item">
                  <span className="words__index">{i + 1}</span> <span className="words__word">{word}</span>
                </li>
              ))}
            </ol>
          </div>
          <p>{uWordsHandwritten(keyAddress)}</p>
          <div className="choices">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                printSection('words-print');
              }}
            >
              Imprimir sólo las palabras
            </button>
            <button
              type="button"
              className="button button--ghost"
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
            />
            Anoté las 17 palabras en orden y las guardo fuera de este dispositivo.
          </label>
          <button
            type="button"
            className="button"
            disabled={!written}
            onClick={() => {
              setError(null);
              setPositions(randomPositions(BACKUP_WORDS, WORDS_TO_CONFIRM));
              setStep('confirm');
            }}
          >
            Ya las anoté
          </button>
        </>
      )}
      {step === 'confirm' && words !== null && (
        <form
          className="form"
          aria-labelledby="confirm-backup-words"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const answers = positions.map((p) => {
              const input = form.elements.namedItem(`backup-word-${String(p)}`);
              return input instanceof HTMLInputElement ? input.value : '';
            });
            if (!confirmationMatches(words, positions, answers)) {
              setError('Alguna palabra no coincide: revisá lo que anotaste.');
              return;
            }
            setWords(null);
            setStep('confirmed');
            onConfirmed();
          }}
        >
          <p id="confirm-backup-words">
            Para comprobar que las anotaste bien, escribí estas {WORDS_TO_CONFIRM} palabras de tu papel.
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
            />
          ))}
          {error && (
            <p className="form__error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button">
            Confirmar las palabras
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setStep('shown');
            }}
          >
            Volver a ver las palabras
          </button>
        </form>
      )}
      {step === 'confirmed' && <Notice tone="success">Palabras anotadas y confirmadas.</Notice>}
      {show.error && <Notice tone="error">{show.error}</Notice>}
    </article>
  );
}
