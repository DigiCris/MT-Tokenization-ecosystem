// De dónde sale el sobre cifrado para desbloquear o restaurar ([F-KEY-10] a/b): el recordado en este dispositivo, el de
// Drive (si Drive no está conectado, se conecta acá: la redirección vuelve a esta pantalla antes de pedir nada
// sensible), un archivo o el QR (cámara). Todos se validan como sobre antes de usarlos.
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { drive, driveOAuth } from '../app/services.ts';
import { parseEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { downloadEnvelope } from '../drive/backup.ts';
import { startDriveConnect, takeDriveConnectError } from '../drive/oauth.ts';
import { hasDriveToken } from '../drive/token.ts';
import { FrameCollector } from '../qr/frames.ts';
import { rememberedEnvelope } from '../storage/envelope-cache.ts';
import { readTextFile } from '../ui/download.ts';
import { describeError } from '../ui/errors.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';
import { QrScanner } from '../ui/QrScanner.tsx';

type Source = 'device' | 'drive' | 'file' | 'qr';

export function EnvelopeSource({
  onEnvelope,
  allowQr = false,
}: {
  onEnvelope: (envelope: KeyEnvelope) => void;
  allowQr?: boolean;
}) {
  const location = useLocation();
  const [remembered, setRemembered] = useState<KeyEnvelope | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [connectError] = useState(() => takeDriveConnectError());
  const [scanError, setScanError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [collector] = useState(() => new FrameCollector());

  useEffect(() => {
    void rememberedEnvelope().then(setRemembered);
  }, []);

  const fromDrive = useAsyncAction(
    useCallback(async () => {
      const envelope = await downloadEnvelope(drive);
      if (envelope === null) throw new Error('No hay un sobre de MT Wallet en tu Drive (carpeta privada de la app)');
      onEnvelope(envelope);
    }, [onEnvelope]),
  );
  const fromFile = useAsyncAction(
    useCallback(
      async (file: File) => {
        const text = await readTextFile(file);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error('El archivo no es un sobre de MT Wallet');
        }
        onEnvelope(parseEnvelope(parsed));
      },
      [onEnvelope],
    ),
  );
  const onQrText = useCallback(
    (text: string) => {
      void (async () => {
        try {
          setProgress(collector.add(text));
          const content = await collector.content();
          if (content !== null) onEnvelope(parseEnvelope(JSON.parse(content)));
        } catch (error) {
          setScanError(describeError(error));
        }
      })();
    },
    [collector, onEnvelope],
  );

  return (
    <div className="stack">
      {connectError && <Notice tone="error">{connectError.message}</Notice>}
      <div className="choices" role="group" aria-label="Origen del sobre cifrado">
        {remembered && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              onEnvelope(remembered);
            }}
          >
            Usar el sobre guardado en este dispositivo
          </button>
        )}
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setSource('drive');
          }}
        >
          Desde Google Drive
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setSource('file');
          }}
        >
          Desde un archivo
        </button>
        {allowQr && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setSource('qr');
            }}
          >
            Desde el QR
          </button>
        )}
      </div>

      {source === 'drive' &&
        (hasDriveToken() ? (
          <div className="stack">
            {fromDrive.error && <Notice tone="error">{fromDrive.error}</Notice>}
            <button
              type="button"
              className="button"
              disabled={fromDrive.pending}
              aria-busy={fromDrive.pending}
              onClick={() => void fromDrive.run()}
            >
              {fromDrive.pending ? 'Leyendo Drive…' : 'Traer el sobre de Drive'}
            </button>
          </div>
        ) : (
          <div className="stack">
            <p>Vas a ir a Google para autorizar sólo la carpeta privada de la app y volver acá.</p>
            <button
              type="button"
              className="button"
              disabled={driveOAuth === null}
              onClick={() => {
                startDriveConnect(driveOAuth, `${location.pathname}${location.search}`);
              }}
            >
              Conectar Google Drive
            </button>
            {driveOAuth === null && <Notice tone="error">Google Drive no está configurado en este entorno.</Notice>}
          </div>
        ))}

      {source === 'file' && (
        <div className="field">
          <label htmlFor="envelope-file" className="field__label">
            Archivo del sobre cifrado (mtw-U-….enc.json)
          </label>
          <input
            id="envelope-file"
            type="file"
            accept="application/json,.json"
            className="field__input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void fromFile.run(file);
            }}
          />
          {fromFile.error && (
            <p className="field__error" role="alert">
              {fromFile.error}
            </p>
          )}
        </div>
      )}

      {source === 'qr' && (
        <div className="stack">
          <QrScanner active onText={onQrText} />
          {progress && progress.total > 1 && (
            <p role="status">
              Leídas {progress.received} de {progress.total} partes del QR
            </p>
          )}
          {scanError && <Notice tone="error">{scanError}</Notice>}
        </div>
      )}
    </div>
  );
}
