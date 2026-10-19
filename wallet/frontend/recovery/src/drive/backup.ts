// Backup del sobre de R en el Drive de Recovery ([F-KEY-06], [F-DRV-02]): `R.enc.<walletId>.json` en la carpeta privada
// de la app (uno por wallet: una migración o un reemplazo de R no pisan el de otra wallet), exactamente la serialización
// del sobre (la misma del archivo descargable). Subir verifica byte a byte; restaurar en un dispositivo nuevo lista los
// sobres de la carpeta y valida el elegido. No cuenta como el backup independiente de la plataforma: el cliente OAuth
// es de la plataforma.
import { utf8 } from '../crypto/encoding.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope, type RecoveryEnvelope } from '../crypto/envelope.ts';
import { DriveError, type DriveClient, type DriveFile } from './client.ts';

const NAME = /^R\.enc\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export function backupName(walletId: string): string {
  const name = `R.enc.${walletId}.json`;
  if (!NAME.test(name)) throw new TypeError('walletId inválido para el nombre del backup');
  return name;
}

/** Sube el sobre (crea o reemplaza el de esa wallet) y verifica que Drive guardó exactamente esos bytes. */
export async function uploadRecoveryEnvelope(drive: DriveClient, envelope: RecoveryEnvelope): Promise<DriveFile> {
  const { file } = await drive.uploadVerified(backupName(envelope.walletId), utf8(serializeRecoveryEnvelope(envelope)));
  return file;
}

export interface RecoveryBackup {
  file: DriveFile;
  walletId: string;
}

/** Los sobres de R guardados en la carpeta de la app (el más reciente primero). */
export async function listRecoveryBackups(drive: DriveClient): Promise<RecoveryBackup[]> {
  const files = await drive.listMatching((name) => NAME.test(name));
  return files.map((file) => ({ file, walletId: NAME.exec(file.name)?.[1] ?? '' }));
}

/** Descarga y valida un sobre de la carpeta: tiene que ser un `R.enc` de la wallet de su nombre. */
export async function downloadRecoveryEnvelope(drive: DriveClient, backup: RecoveryBackup): Promise<RecoveryEnvelope> {
  const bytes = await drive.download(backup.file.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DriveError('UNEXPECTED', 'El backup de Drive no es un sobre válido');
  }
  const envelope = parseRecoveryEnvelope(parsed);
  if (envelope.walletId !== backup.walletId) {
    throw new DriveError('UNEXPECTED', 'El sobre de Drive no es de la wallet que indica su nombre');
  }
  return envelope;
}
