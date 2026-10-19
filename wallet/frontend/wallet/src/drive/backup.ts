// Backup del sobre de U en Drive ([F-KEY-06].1, [F-DRV-02], [F-DRV-05]): `U.enc.json` en la carpeta privada de la app,
// exactamente la serialización del sobre (la misma del archivo descargable). Subir verifica byte a byte; el chequeo de
// salud compara el SHA-256 del archivo de Drive con el del sobre conocido y deja el resultado en flags no sensibles.
import { toHex, utf8 } from '../crypto/bytes.ts';
import { parseEnvelope, serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';
import { sha256 } from '../api/session-key.ts';
import { clearFlag, readFlag, writeFlag } from '../storage/flags.ts';
import { DriveError, type DriveClient } from './client.ts';

export const ENVELOPE_FILE = 'U.enc.json';
/** [F-DRV-05]: cada 7 días o a pedido del usuario. */
export const HEALTH_INTERVAL_MS = 7 * 24 * 60 * 60_000;

export async function envelopeSha256(envelope: KeyEnvelope): Promise<string> {
  return toHex(await sha256(utf8(serializeEnvelope(envelope)))).slice(2);
}

/** Sube el sobre y lo verifica; registra su hash como el esperado para el chequeo de salud. */
export async function uploadEnvelope(
  drive: DriveClient,
  envelope: KeyEnvelope,
  name: string = ENVELOPE_FILE,
): Promise<{ fileId: string }> {
  const content = utf8(serializeEnvelope(envelope));
  const { file } = await drive.uploadVerified(name, content);
  writeFlag('drive.backup.sha256', await envelopeSha256(envelope));
  writeFlag('drive.backup.checkedAt', String(Date.now()));
  writeFlag('drive.backup.status', 'ok');
  return { fileId: file.id };
}

/** El sobre guardado en Drive (validado); null si no hay. */
export async function downloadEnvelope(drive: DriveClient, name: string = ENVELOPE_FILE): Promise<KeyEnvelope | null> {
  const file = await drive.find(name);
  if (file === null) return null;
  const bytes = await drive.download(file.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DriveError('UNEXPECTED', 'El backup de Drive no es un sobre válido');
  }
  return parseEnvelope(parsed);
}

export type BackupHealth = 'ok' | 'missing' | 'mismatch' | 'unknown';

export interface HealthState {
  status: BackupHealth;
  checkedAt: number | null;
  due: boolean;
}

/** Estado del último chequeo y si toca otro (nunca bloquea el desbloqueo: sólo se muestra un aviso). */
export function backupHealth(now: number = Date.now()): HealthState {
  const status = readFlag('drive.backup.status');
  const checkedAt = Number(readFlag('drive.backup.checkedAt'));
  const known = status === 'ok' || status === 'missing' || status === 'mismatch';
  const at = Number.isSafeInteger(checkedAt) && checkedAt > 0 ? checkedAt : null;
  return {
    status: known ? status : 'unknown',
    checkedAt: at,
    due: readFlag('drive.backup.sha256') !== null && (at === null || now - at >= HEALTH_INTERVAL_MS || status !== 'ok'),
  };
}

/**
 * El estado para el usuario: es el resultado de la última verificación (no de ahora), así que lleva su fecha y hora (en
 * el huso del dispositivo salvo que se pase otro).
 */
export function backupHealthText(health: HealthState, timeZone?: string): string {
  if (health.status === 'unknown') return 'Todavía no se verificó el backup en Drive en este dispositivo.';
  const when =
    health.checkedAt === null
      ? 'En la última verificación'
      : `En la última verificación (${new Date(health.checkedAt).toLocaleString('es-AR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          ...(timeZone === undefined ? {} : { timeZone }),
        })})`;
  if (health.status === 'missing') return `${when} faltaba el backup en Drive: volvé a subirlo.`;
  if (health.status === 'mismatch') {
    return `${when}, el backup en Drive no coincidía con tu sobre actual: volvé a subirlo.`;
  }
  return `${when}, el backup en Drive estaba y coincidía con tu sobre.${health.due ? ' Toca verificarlo de nuevo.' : ''}`;
}

/**
 * [F-DRV-05]: con Drive conectado, verifica que `U.enc.json` siga ahí y coincida (SHA-256) con el sobre esperado (el
 * del dispositivo o, si se pasa, el desbloqueado). Si falta o no coincide, queda la alerta persistente hasta re-subirlo.
 */
export async function checkBackupHealth(
  drive: DriveClient,
  expected?: KeyEnvelope,
  name: string = ENVELOPE_FILE,
): Promise<BackupHealth> {
  const expectedHash = expected ? await envelopeSha256(expected) : readFlag('drive.backup.sha256');
  if (expected) writeFlag('drive.backup.sha256', expectedHash ?? '');
  const file = await drive.find(name);
  let status: BackupHealth;
  if (file === null) status = 'missing';
  else {
    const bytes = await drive.download(file.id);
    const actual = toHex(await sha256(bytes)).slice(2);
    status = expectedHash !== null && actual === expectedHash ? 'ok' : 'mismatch';
  }
  writeFlag('drive.backup.status', status);
  writeFlag('drive.backup.checkedAt', String(Date.now()));
  return status;
}

/** Sin backup en Drive para este dispositivo (p. ej. tras borrar la wallet local). */
export function forgetBackupHealth(): void {
  for (const name of ['drive.backup.sha256', 'drive.backup.checkedAt', 'drive.backup.status']) clearFlag(name);
}
