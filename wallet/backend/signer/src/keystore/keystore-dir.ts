// Directorio de keystores de un shard [B-SIG-08]: un archivo `<dirección en minúsculas>.json` por clave, permisos 0400
// del UID del signer, directorio 0700. Nada más vive acá (la credencial de desbloqueo está en otro directorio).
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress, type Address } from '../crypto/keccak.ts';
import { atomicWriteFile, fsyncDirectory, TEMP_PREFIX } from './atomic-write.ts';
import type { KeystoreV3 } from './v3.ts';

const KEYSTORE_FILE = /^(0x[0-9a-f]{40})\.json$/;
const MAX_KEYSTORE_BYTES = 16 * 1024;

export interface DirectoryIndex {
  /** Direcciones con un archivo de keystore bien nombrado. */
  addresses: Address[];
  /** Archivos que no deberían estar (temporales huérfanos, nombres desconocidos, subdirectorios). */
  unexpected: string[];
}

export type KeystoreFileProblem = 'MISSING' | 'UNREADABLE' | 'NOT_JSON' | 'TOO_LARGE';

export class KeystoreFileError extends Error {
  override name = 'KeystoreFileError';
  readonly problem: KeystoreFileProblem;
  readonly address: Address | undefined;

  constructor(problem: KeystoreFileProblem, address?: Address) {
    super(`archivo de keystore ${problem}`);
    this.problem = problem;
    this.address = address;
  }
}

export class KeystoreDirectory {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Crea el directorio (0700) si no existe. */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  pathOf(address: Address): string {
    if (!isAddress(address)) throw new TypeError('dirección inválida');
    return join(this.dir, `${address.toLowerCase()}.json`);
  }

  exists(address: Address): boolean {
    try {
      return lstatSync(this.pathOf(address)).isFile();
    } catch {
      return false;
    }
  }

  index(): DirectoryIndex {
    const addresses: Address[] = [];
    const unexpected: string[] = [];
    for (const name of readdirSync(this.dir)) {
      const match = KEYSTORE_FILE.exec(name);
      const stats = lstatSync(join(this.dir, name));
      if (match?.[1] && stats.isFile()) addresses.push(match[1] as Address);
      else unexpected.push(name.startsWith(TEMP_PREFIX) ? `${name} (temporal huérfano)` : name);
    }
    return { addresses: addresses.sort(), unexpected: unexpected.sort() };
  }

  read(address: Address): unknown {
    const path = this.pathOf(address);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      throw new KeystoreFileError('MISSING', address);
    }
    if (!stats.isFile()) throw new KeystoreFileError('UNREADABLE', address);
    if (stats.size > MAX_KEYSTORE_BYTES) throw new KeystoreFileError('TOO_LARGE', address);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new KeystoreFileError('UNREADABLE', address);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new KeystoreFileError('NOT_JSON', address);
    }
  }

  write(address: Address, keystore: KeystoreV3, options: { replace?: boolean } = {}): void {
    atomicWriteFile(this.pathOf(address), `${JSON.stringify(keystore)}\n`, {
      mode: 0o400,
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    });
  }

  /** Borra el archivo de una clave (destrucción tras la retención de 30 días, o rollback de un alta fallida). */
  remove(address: Address): void {
    unlinkSync(this.pathOf(address));
    fsyncDirectory(this.dir);
  }

  /**
   * Problemas de permisos [P11.SEC]: directorio 0700 y archivos 0400, todos del UID del proceso. Devuelve la lista de
   * problemas (vacía si está todo bien).
   */
  permissionProblems(): string[] {
    const problems: string[] = [];
    const uid = process.getuid?.();
    const dirStats = statSync(this.dir);
    if ((dirStats.mode & 0o777) !== 0o700)
      problems.push(`directorio de keystores con permisos ${octal(dirStats.mode)}`);
    if (uid !== undefined && dirStats.uid !== uid) problems.push('directorio de keystores de otro usuario');
    for (const address of this.index().addresses) {
      const stats = lstatSync(this.pathOf(address));
      if ((stats.mode & 0o777) !== 0o400) problems.push(`${address}.json con permisos ${octal(stats.mode)}`);
      if (uid !== undefined && stats.uid !== uid) problems.push(`${address}.json de otro usuario`);
    }
    return problems;
  }
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}
