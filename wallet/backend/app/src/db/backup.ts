// Backup y restore lógicos de la base del backend para local (P08.T03): pg_dump/pg_restore dentro del contenedor de
// PostgreSQL (misma versión que el servidor; socket local, sin passwords en la línea de comandos). Staging y
// producción usan pgBackRest con WAL archiving y copia off-host cifrada (ADR-031, P26): esta herramienta se niega.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

export interface PgTarget {
  /** Id o nombre del contenedor de PostgreSQL. */
  container: string;
  user: string;
  database: string;
}

export class BackupError extends Error {
  override name = 'BackupError';
}

/** Contenedor del servicio `postgres` del docker compose local. */
export async function composePostgresContainer(composeFile: string): Promise<string> {
  const id = await run('docker', ['compose', '-f', composeFile, 'ps', '-q', 'postgres']);
  const container = id.trim();
  if (!container) throw new BackupError('el contenedor postgres del docker compose local no está corriendo');
  return container;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun(out);
      else reject(new BackupError(`${command} ${args[0] ?? ''} terminó con ${code}: ${err.trim().slice(-500)}`));
    });
  });
}

/** pg_dump en formato custom hacia `outFile` (escritura atómica, permisos 0600). */
export async function backupDatabase(target: PgTarget, outFile: string): Promise<void> {
  const tmp = `${outFile}.partial`;
  await new Promise<void>((resolveDump, reject) => {
    const out = createWriteStream(tmp, { mode: 0o600 });
    const child = spawn(
      'docker',
      [
        'exec',
        target.container,
        'pg_dump',
        '-U',
        target.user,
        '-d',
        target.database,
        '--format=custom',
        '--compress=6',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.stdout.pipe(out);
    child.on('error', reject);
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolveDump();
        else reject(new BackupError(`pg_dump terminó con ${code}: ${err.trim().slice(-500)}`));
      });
    });
  }).catch(async (error: unknown) => {
    await rm(tmp, { force: true });
    throw error;
  });
  await rename(tmp, outFile);
}

/** pg_restore --clean en una sola transacción (si algo falla, la base queda como estaba). */
export async function restoreDatabase(target: PgTarget, file: string): Promise<void> {
  await new Promise<void>((resolveRestore, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        target.container,
        'pg_restore',
        '-U',
        target.user,
        '-d',
        target.database,
        '--clean',
        '--if-exists',
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--role',
        target.user,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    createReadStream(file).pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRestore();
      else reject(new BackupError(`pg_restore terminó con ${code}: ${err.trim().slice(-500)}`));
    });
  });
}
