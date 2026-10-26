// Backup del sobre de R en el Drive de Recovery ([F-KEY-06], [F-DRV-02]) en la carpeta privada de la app, exactamente
// la serialización del sobre (la misma del archivo descargable). Uno por clave: `R.enc.<walletId>.<dirección de R en
// minúsculas, sin 0x>.json`, así una migración no pisa el de otra wallet y un reemplazo de R no pisa la copia de la R
// vigente, que sigue siendo la de recuperación hasta que el reemplazo se ejecute (N13 de la verificación de P17.MAN).
// Los que se subieron antes con el nombre por wallet (`R.enc.<walletId>.json`) se siguen listando y restaurando. Subir
// verifica byte a byte; restaurar en un dispositivo nuevo lista los sobres de la carpeta con la dirección de la R de cada
// uno, leída del contenido y comparada con la del nombre, y sólo ofrece los que validan. No cuenta como el backup
// independiente de la plataforma: el cliente OAuth es de la plataforma.
import { getAddress, isAddressEqual, type Address } from 'viem';
import { utf8 } from '../crypto/encoding.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope, type RecoveryEnvelope } from '../crypto/envelope.ts';
import { DriveError, type DriveClient, type DriveFile } from './client.ts';

/** `R.enc.<walletId>.<40 hex>.json` (uno por clave) o, como antes, `R.enc.<walletId>.json` (uno por wallet). */
const NAME = /^R\.enc\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.([0-9a-f]{40}))?\.json$/;

export function backupName(walletId: string, keyAddress: Address): string {
  const name = `R.enc.${walletId}.${getAddress(keyAddress).slice(2).toLowerCase()}.json`;
  if (!NAME.test(name)) throw new TypeError('walletId inválido para el nombre del backup');
  return name;
}

/** Sube el sobre (crea o reemplaza el de esa clave) y verifica que Drive guardó exactamente esos bytes. */
export async function uploadRecoveryEnvelope(drive: DriveClient, envelope: RecoveryEnvelope): Promise<DriveFile> {
  const name = backupName(envelope.walletId, envelope.keyAddress);
  const { file } = await drive.uploadVerified(name, utf8(serializeRecoveryEnvelope(envelope)));
  return file;
}

/** Un sobre de la carpeta, ya leído y validado: su wallet y la dirección de su R (la del contenido). */
export interface RecoveryBackup {
  file: DriveFile;
  walletId: string;
  keyAddress: Address;
  envelope: RecoveryEnvelope;
}

/**
 * Descarga y valida un archivo de la carpeta: tiene que ser un `R.enc` de la wallet de su nombre y, con el nombre por
 * clave, de la R de su nombre. Un nombre que no es de un sobre de R también es un error.
 */
export async function readRecoveryBackup(drive: DriveClient, file: DriveFile): Promise<RecoveryBackup> {
  const match = NAME.exec(file.name);
  if (match === null) throw new DriveError('UNEXPECTED', 'El archivo de Drive no es un sobre de R');
  const [, walletId = '', keyHex] = match;
  const bytes = await drive.download(file.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DriveError('UNEXPECTED', 'El backup de Drive no es un sobre válido');
  }
  let envelope: RecoveryEnvelope;
  try {
    envelope = parseRecoveryEnvelope(parsed);
  } catch {
    throw new DriveError('UNEXPECTED', 'El backup de Drive no es un sobre válido');
  }
  if (envelope.walletId !== walletId) {
    throw new DriveError('UNEXPECTED', 'El sobre de Drive no es de la wallet que indica su nombre');
  }
  if (keyHex !== undefined && !isAddressEqual(envelope.keyAddress, `0x${keyHex}`)) {
    throw new DriveError('UNEXPECTED', 'El sobre de Drive no es de la clave R que indica su nombre');
  }
  return { file, walletId, keyAddress: getAddress(envelope.keyAddress), envelope };
}

/**
 * Los sobres de R de la carpeta de la app (el más reciente primero), cada uno descargado y validado contra su nombre.
 * Los que no validan no se ofrecen (se cuentan en `unreadable`) y uno que se borró entre el listado y la descarga (desde
 * otro dispositivo) no está; otro error de Drive (sin conexión, token vencido) corta.
 */
export async function listRecoveryBackups(
  drive: DriveClient,
): Promise<{ backups: RecoveryBackup[]; unreadable: number }> {
  const files = await drive.listMatching((name) => NAME.test(name));
  const backups: RecoveryBackup[] = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      backups.push(await readRecoveryBackup(drive, file));
    } catch (error) {
      if (error instanceof DriveError && error.code === 'NOT_FOUND') continue;
      // Sólo un contenido que no valida (sin status HTTP): un 5xx de Drive no es un sobre inválido.
      if (!(error instanceof DriveError) || error.code !== 'UNEXPECTED' || error.status !== null) throw error;
      unreadable += 1;
    }
  }
  return { backups, unreadable };
}
