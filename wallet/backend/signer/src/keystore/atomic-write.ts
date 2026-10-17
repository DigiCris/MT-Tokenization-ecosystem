// Escritura atómica [B-SIG-08]: archivo temporal en el mismo directorio → write + fsync → chmod final → rename →
// fsync del directorio. Un corte en cualquier punto deja el archivo anterior intacto o el nuevo completo, nunca uno
// truncado. Sin `replace`, no pisa un archivo existente.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const TEMP_PREFIX = '.tmp-';

export interface AtomicWriteOptions {
  /** Permisos finales del archivo (default 0400: sólo lectura del dueño). */
  mode?: number;
  /** Reemplaza un archivo existente (re-cifrado por rotación de credencial). */
  replace?: boolean;
}

export function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteFile(path: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const dir = dirname(path);
  const temp = join(dir, `${TEMP_PREFIX}${basename(path)}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    // Permisos finales sobre el mismo descriptor, antes del rename: el archivo final nunca es más permisivo.
    fchmodSync(fd, options.mode ?? 0o400);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  try {
    if (options.replace === true) {
      renameSync(temp, path);
    } else {
      // link(2) falla si el destino existe: crear sin pisar, de forma atómica.
      linkSync(temp, path);
      unlinkSync(temp);
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ya no existe
    }
    throw error;
  }
  fsyncDirectory(dir);
}
