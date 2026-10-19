// Seguridad (§8.4): sesiones, verificación en dos pasos, backups del sobre (estado del chequeo de Drive [F-DRV-05] con
// la fecha de la última verificación, re-exportar el archivo y el QR, [F-UI]), cambiar la Password U, "perdí mi
// Password U" y las claves de la Safe (rotaciones, reemplazo de R, migración y co-firma soberana, P18). El chequeo de
// Drive nunca bloquea nada: si falta o no coincide, queda la alerta hasta re-subirlo.
import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { drive, driveOAuth } from '../app/services.ts';
import { serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { backupHealth, backupHealthText, checkBackupHealth, uploadEnvelope } from '../drive/backup.ts';
import { startDriveConnect } from '../drive/oauth.ts';
import { hasDriveToken } from '../drive/token.ts';
import { EnvelopeQr } from '../onboarding/EnvelopeQr.tsx';
import { encodeFrames } from '../qr/frames.ts';
import { useSession } from '../session/context.tsx';
import { rememberedEnvelope } from '../storage/envelope-cache.ts';
import { downloadText, envelopeFileName } from '../ui/download.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';

export function SecurityPage() {
  const { unlocked } = useSession();
  const location = useLocation();
  const [health, setHealth] = useState(() => backupHealth());
  const [qrFrames, setQrFrames] = useState<string[] | null>(null);

  const knownEnvelope = useCallback(async (): Promise<KeyEnvelope | null> => {
    return unlocked?.envelope ?? (await rememberedEnvelope());
  }, [unlocked]);

  const check = useAsyncAction(
    useCallback(async () => {
      await checkBackupHealth(drive, (await knownEnvelope()) ?? undefined);
      setHealth(backupHealth());
    }, [knownEnvelope]),
  );
  const reupload = useAsyncAction(
    useCallback(async () => {
      const envelope = await knownEnvelope();
      if (envelope === null)
        throw new Error('Desbloqueá la wallet o recordá el sobre en este dispositivo para re-subirlo');
      await uploadEnvelope(drive, envelope);
      setHealth(backupHealth());
    }, [knownEnvelope]),
  );
  const exportFile = useAsyncAction(
    useCallback(async () => {
      const envelope = await knownEnvelope();
      if (envelope === null) throw new Error('Desbloqueá la wallet para exportar el sobre cifrado');
      downloadText(envelopeFileName(envelope.walletId), serializeEnvelope(envelope));
    }, [knownEnvelope]),
  );
  const exportQr = useAsyncAction(
    useCallback(async () => {
      const envelope = await knownEnvelope();
      if (envelope === null) throw new Error('Desbloqueá la wallet para exportar el sobre cifrado');
      setQrFrames(await encodeFrames(JSON.stringify(envelope)));
    }, [knownEnvelope]),
  );

  return (
    <section className="stack" aria-labelledby="security-title">
      <h1 id="security-title">Seguridad</h1>
      <nav className="card stack" aria-label="Cuenta">
        <h2>Cuenta</h2>
        <Link to="/security/sessions">Sesiones abiertas</Link>
        <Link to="/security/totp">Verificación en dos pasos</Link>
      </nav>

      <article className="card stack" aria-labelledby="backups-title">
        <h2 id="backups-title">Backups de tu clave</h2>
        <Notice tone={health.status === 'ok' ? 'success' : health.status === 'unknown' ? 'info' : 'error'}>
          {backupHealthText(health)}
        </Notice>
        {hasDriveToken() ? (
          <div className="choices">
            <button
              type="button"
              className="button button--ghost"
              disabled={check.pending}
              aria-busy={check.pending}
              onClick={() => void check.run()}
            >
              Verificar el backup en Drive
            </button>
            {health.status !== 'ok' && health.status !== 'unknown' && (
              <button
                type="button"
                className="button"
                disabled={reupload.pending}
                aria-busy={reupload.pending}
                onClick={() => void reupload.run()}
              >
                Volver a subir el sobre
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="button button--ghost"
            disabled={driveOAuth === null}
            onClick={() => {
              startDriveConnect(driveOAuth, location.pathname);
            }}
          >
            Conectar Drive para verificar el backup
          </button>
        )}
        {check.error && <Notice tone="error">{check.error}</Notice>}
        {reupload.error && <Notice tone="error">{reupload.error}</Notice>}
        <p>
          Podés volver a exportar el sobre cifrado como archivo o como QR. Los dos se abren sólo con tu Password U:
          guardalos fuera de este dispositivo y sin la Password U al lado.
        </p>
        <div className="choices">
          <button
            type="button"
            className="button button--ghost"
            disabled={exportFile.pending}
            aria-busy={exportFile.pending}
            onClick={() => void exportFile.run()}
          >
            Descargar el sobre cifrado
          </button>
          {qrFrames === null && (
            <button
              type="button"
              className="button button--ghost"
              disabled={exportQr.pending}
              aria-busy={exportQr.pending}
              onClick={() => void exportQr.run()}
            >
              Mostrar el QR del sobre cifrado
            </button>
          )}
        </div>
        {exportFile.error && <Notice tone="error">{exportFile.error}</Notice>}
        {exportQr.error && <Notice tone="error">{exportQr.error}</Notice>}
        {qrFrames !== null && <EnvelopeQr frames={qrFrames} printId="security-qr-print" />}
      </article>

      <nav className="card stack" aria-label="Password U">
        <h2>Password U</h2>
        <Link to="/security/password-u">Cambiar la Password U</Link>
        <Link to="/security/lost-password-u">Perdí mi Password U</Link>
      </nav>

      <nav className="card stack" aria-label="Claves de la Safe">
        <h2>Claves de tu Safe</h2>
        <Link to="/security/rotations">Rotaciones (pendientes, cancelar, ejecutar)</Link>
        <Link to="/security/recovery">Estado y reemplazo de tu clave de recuperación (R)</Link>
        <Link to="/security/migration">Migración excepcional</Link>
        <Link to="/sovereign" reloadDocument>
          Co-firmar una operación soberana
        </Link>
      </nav>
    </section>
  );
}
