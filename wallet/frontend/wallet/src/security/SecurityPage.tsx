// Seguridad (§8.4): sesiones, verificación en dos pasos, backups del sobre (estado del chequeo de Drive [F-DRV-05],
// re-exportar archivo o QR), cambiar la Password U y "perdí mi Password U". El chequeo de Drive nunca bloquea nada: si
// falta o no coincide, queda la alerta hasta re-subirlo.
import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { drive, driveOAuth } from '../app/services.ts';
import { serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { backupHealth, checkBackupHealth, uploadEnvelope, type BackupHealth } from '../drive/backup.ts';
import { startDriveConnect } from '../drive/oauth.ts';
import { hasDriveToken } from '../drive/token.ts';
import { useSession } from '../session/context.tsx';
import { rememberedEnvelope } from '../storage/envelope-cache.ts';
import { downloadText, envelopeFileName } from '../ui/download.ts';
import { Notice, useAsyncAction } from '../ui/forms.tsx';

const HEALTH_TEXT: Record<BackupHealth, string> = {
  ok: 'El backup en Drive está y coincide con tu sobre.',
  missing: 'Falta el backup en Drive: volvé a subirlo.',
  mismatch: 'El backup en Drive no coincide con tu sobre actual: volvé a subirlo.',
  unknown: 'Todavía no se verificó el backup en Drive en este dispositivo.',
};

export function SecurityPage() {
  const { unlocked } = useSession();
  const location = useLocation();
  const [health, setHealth] = useState(() => backupHealth());

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
          {HEALTH_TEXT[health.status]}
          {health.due && health.status === 'ok' && ' Toca verificarlo de nuevo.'}
        </Notice>
        {hasDriveToken() ? (
          <div className="choices">
            <button
              type="button"
              className="button button--ghost"
              disabled={check.pending}
              onClick={() => void check.run()}
            >
              Verificar el backup en Drive
            </button>
            {health.status !== 'ok' && health.status !== 'unknown' && (
              <button type="button" className="button" disabled={reupload.pending} onClick={() => void reupload.run()}>
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
        <button
          type="button"
          className="button button--ghost"
          disabled={exportFile.pending}
          onClick={() => void exportFile.run()}
        >
          Descargar el sobre cifrado
        </button>
        {exportFile.error && <Notice tone="error">{exportFile.error}</Notice>}
      </article>

      <nav className="card stack" aria-label="Password U">
        <h2>Password U</h2>
        <Link to="/security/password-u">Cambiar la Password U</Link>
        <Link to="/security/lost-password-u">Perdí mi Password U</Link>
      </nav>
    </section>
  );
}
