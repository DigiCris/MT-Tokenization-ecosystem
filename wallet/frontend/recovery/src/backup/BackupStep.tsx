// Backups de R ([F-KEY-06]): antes de enviar el enrollment, R necesita al menos un backup que no dependa de la
// plataforma —el archivo cifrado, el QR del sobre o las 17 palabras—, porque la salida soberana tiene que funcionar
// aunque la plataforma desaparezca. El Drive de Recovery (si se conectó antes de crear R: la redirección de Google no
// conserva lo que está en memoria) suma comodidad pero no cuenta como independiente: su cliente OAuth es de la
// plataforma. Cada backup hecho y confirmado queda en los storageFlags del enrollment.
import { useState } from 'react';
import type { StorageFlags } from '../api/recovery-api.ts';
import { uploadRecoveryEnvelope } from '../drive/backup.ts';
import { DriveClient } from '../drive/client.ts';
import { driveToken, hasDriveToken } from '../drive/token.ts';
import { recoveryKeyToWords } from '../crypto/backup-words.ts';
import { envelopeFileName, serializeRecoveryEnvelope } from '../crypto/envelope.ts';
import { withRecoveryKey, type UnlockedRecovery } from '../crypto/session.ts';
import { loadWordlist } from '../crypto/wordlist.ts';
import { encodeFrames } from '../qr/frames.ts';
import { downloadText } from '../ui/download.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrFrames } from '../ui/QrCanvas.tsx';
import { Words } from '../ui/Words.tsx';

export function BackupStep({
  unlocked,
  onDone,
}: {
  unlocked: UnlockedRecovery;
  onDone: (flags: StorageFlags) => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [flags, setFlags] = useState<StorageFlags>({ drive: false, file: false, qr: false, words: false });
  const independent = flags.file || flags.qr || flags.words;

  const showQr = useAsyncAction(async () => {
    setFrames(await encodeFrames(JSON.stringify(unlocked.envelope)));
  });
  const showWords = useAsyncAction(async () => {
    const wordlist = await loadWordlist();
    setWords(await withRecoveryKey(unlocked, (key) => recoveryKeyToWords(key, wordlist)));
  });
  const saveToDrive = useAsyncAction(async () => {
    await uploadRecoveryEnvelope(new DriveClient(() => driveToken()), unlocked.envelope);
    setFlags((f) => ({ ...f, drive: true }));
  });

  return (
    <section className="card stack" aria-labelledby="backup-title">
      <h2 id="backup-title">Backups de tu clave R</h2>
      <p>
        Hacé al menos un backup que no dependa de la plataforma. Con él y tu Password R vas a poder recuperar tu wallet
        aunque la plataforma no exista más.
      </p>

      {hasDriveToken() && (
        <div className="stack">
          <h3>Google Drive de Recovery</h3>
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
        {downloaded && (
          <label className="check">
            <input
              type="checkbox"
              checked={flags.file}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setFlags((f) => ({ ...f, file: checked }));
              }}
            />{' '}
            Guardé el archivo fuera de este dispositivo
          </label>
        )}
      </div>

      <div className="stack">
        <h3>QR del sobre cifrado</h3>
        {frames === null ? (
          <button type="button" className="button button--secondary" onClick={() => void showQr.run()}>
            Mostrar el QR
          </button>
        ) : (
          <>
            <QrFrames frames={frames} label="QR del sobre cifrado de R" />
            <label className="check">
              <input
                type="checkbox"
                checked={flags.qr}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setFlags((f) => ({ ...f, qr: checked }));
                }}
              />{' '}
              Guardé o imprimí el QR (todos sus cuadros)
            </label>
          </>
        )}
        {showQr.error && <Notice tone="error">{showQr.error}</Notice>}
      </div>

      <div className="stack">
        <h3>17 palabras</h3>
        <p className="muted">
          Son la clave R misma, sin cifrar: quien las tenga puede usar R. Anotalas en papel y guardalas separadas de la
          Password R. Se muestran una sola vez.
        </p>
        {words === null ? (
          <button type="button" className="button button--secondary" onClick={() => void showWords.run()}>
            Ver las 17 palabras
          </button>
        ) : (
          <>
            <Words words={words} label="Backup de R en 17 palabras" />
            <div className="actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  window.print();
                }}
              >
                Imprimir
              </button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={flags.words}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setFlags((f) => ({ ...f, words: checked }));
                  if (checked) setWords(null);
                }}
              />{' '}
              Anoté las 17 palabras y las guardé
            </label>
          </>
        )}
        {showWords.error && <Notice tone="error">{showWords.error}</Notice>}
      </div>

      {!independent && <Notice tone="warning">Falta al menos un backup: archivo, QR o las 17 palabras.</Notice>}
      <button
        type="button"
        className="button"
        disabled={!independent}
        onClick={() => {
          onDone(flags);
        }}
      >
        Continuar
      </button>
    </section>
  );
}
