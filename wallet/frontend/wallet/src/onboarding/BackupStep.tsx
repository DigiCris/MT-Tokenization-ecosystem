// Backups del sobre de U ([F-KEY-06]): Drive (adicional, verificado byte a byte después de subir), archivo cifrado,
// QR del sobre (canvas) y las 17 palabras (una sola vez, con confirmación y opción de imprimir sin otros datos). Hace
// falta al menos un backup que no dependa de la plataforma (archivo, QR o palabras) para seguir.
import { useCallback, useEffect, useState } from 'react';
import type { StorageFlags } from '../api/wallet-api.ts';
import { drive } from '../app/services.ts';
import { keyToBackupWords } from '../crypto/backup-words.ts';
import { serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { uploadEnvelope } from '../drive/backup.ts';
import { hasDriveToken } from '../drive/token.ts';
import { encodeFrames } from '../qr/frames.ts';
import { downloadText, envelopeFileName } from '../ui/download.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { printSection } from '../ui/print.ts';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { hasIndependentBackup } from './user-key.ts';

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
  const [words, setWords] = useState<string[] | null>(null);
  const [wordsShown, setWordsShown] = useState(false);
  const driveConnected = hasDriveToken();

  const upload = useAsyncAction(
    useCallback(async () => {
      await uploadEnvelope(drive, envelope);
      setFlags((f) => ({ ...f, drive: true }));
    }, [envelope]),
  );
  const showWords = useAsyncAction(
    useCallback(async () => {
      if (!wordsKey) return;
      setWords(await keyToBackupWords('U', wordsKey, await loadWordlist()));
      setWordsShown(true);
    }, [wordsKey]),
  );
  const showQr = useAsyncAction(
    useCallback(async () => {
      setFrames(await encodeFrames(JSON.stringify(envelope)));
    }, [envelope]),
  );
  useEffect(
    () => () => {
      setWords(null);
    },
    [],
  );

  const check = (name: keyof StorageFlags) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setFlags((f) => ({ ...f, [name]: value }));
    if (name === 'words' && value) setWords(null);
  };

  return (
    <div className="stack" aria-label="Backups de la clave">
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
              <button type="button" className="button" disabled={upload.pending} onClick={() => void upload.run()}>
                {upload.pending ? 'Subiendo y verificando…' : 'Subir a Drive y verificar'}
              </button>
            </>
          )
        ) : (
          <Notice>Drive no está conectado en esta sesión: este backup queda pendiente.</Notice>
        )}
      </article>

      <Notice tone="warning">
        Además necesitás al menos un backup que no dependa de MT Wallet (archivo, QR o las 17 palabras): si la
        plataforma o tu acceso a Drive desaparecen, con él igual recuperás tu clave.
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
            downloadText(envelopeFileName(envelope.walletId), serializeEnvelope(envelope));
            setDownloaded(true);
          }}
        >
          Descargar archivo cifrado
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
            onClick={() => void showQr.run()}
          >
            Mostrar QR
          </button>
        ) : (
          <div className="stack" id="qr-print">
            {frames.map((frame, i) => (
              <figure key={frame} className="qr-frame">
                <QrCanvas
                  text={frame}
                  size={360}
                  label={`QR del sobre cifrado, parte ${String(i + 1)} de ${String(frames.length)}`}
                />
                {frames.length > 1 && (
                  <figcaption>
                    Parte {i + 1} de {frames.length}
                  </figcaption>
                )}
              </figure>
            ))}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                printSection('qr-print');
              }}
            >
              Imprimir QR
            </button>
            <label className="check">
              <input type="checkbox" checked={flags.qr} onChange={check('qr')} />
              Guardé o imprimí el QR fuera de este dispositivo.
            </label>
          </div>
        )}
      </article>

      {wordsKey && (
        <article className="card stack" aria-labelledby="backup-words">
          <h2 id="backup-words">17 palabras de la clave</h2>
          <Notice tone="warning">
            Las 17 palabras son la clave misma: quien las tenga controla la clave sin necesitar la Password U. Se
            muestran una sola vez; anotalas en papel y guardalas aparte.
          </Notice>
          {words !== null ? (
            <div className="stack" id="words-print">
              <ol className="words words--17" aria-label="17 palabras de la clave">
                {words.map((word, i) => (
                  <li key={`${String(i)}-${word}`} className="words__item">
                    <span className="words__index">{i + 1}</span> <span className="words__word">{word}</span>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  printSection('words-print');
                }}
              >
                Imprimir sólo las palabras
              </button>
              <label className="check">
                <input type="checkbox" checked={flags.words} onChange={check('words')} />
                Anoté las 17 palabras en orden y las guardo fuera de este dispositivo.
              </label>
            </div>
          ) : wordsShown ? (
            <Notice tone={flags.words ? 'success' : 'info'}>
              {flags.words ? 'Palabras anotadas.' : 'Las palabras ya se mostraron.'}
            </Notice>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              disabled={showWords.pending}
              onClick={() => void showWords.run()}
            >
              Mostrar las 17 palabras
            </button>
          )}
          {showWords.error && <Notice tone="error">{showWords.error}</Notice>}
        </article>
      )}

      <button
        type="button"
        className="button"
        disabled={!hasIndependentBackup(flags)}
        onClick={() => {
          onDone(flags);
        }}
      >
        {continueLabel}
      </button>
    </div>
  );
}
