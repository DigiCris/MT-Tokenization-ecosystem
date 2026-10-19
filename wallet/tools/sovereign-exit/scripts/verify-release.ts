// Verificación del release de la herramienta, la que hace cualquiera antes de abrirla: la firma Ed25519 de
// `SHA256SUMS` con la clave pública publicada y el SHA-256 del HTML descargado contra ese archivo.
//
// Uso: node scripts/verify-release.ts [--dist <dir>] [--public-key <archivo>]
import { createHash, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releasePublicKey } from './release-keys.ts';
import { HTML, SIGNATURE, SUMS } from './sign-release.ts';

export function verifyRelease(dist: string, key: KeyObject): void {
  const content = readFileSync(join(dist, SUMS));
  const signature = Buffer.from(readFileSync(join(dist, SIGNATURE), 'utf8').trim(), 'base64');
  if (!verify(null, content, key, signature))
    throw new Error('la firma de SHA256SUMS no verifica con la clave publicada');
  const expected = /^([0-9a-f]{64}) {2}sovereign-exit\.html\n$/.exec(content.toString('utf8'))?.[1];
  if (!expected) throw new Error('SHA256SUMS no tiene el formato esperado');
  const actual = createHash('sha256')
    .update(readFileSync(join(dist, HTML)))
    .digest('hex');
  if (actual !== expected) throw new Error('el HTML no es el firmado: no lo abras');
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const { values } = parseArgs({
    options: { dist: { type: 'string', default: join(root, 'dist') }, 'public-key': { type: 'string' } },
  });
  try {
    verifyRelease(resolve(values.dist), releasePublicKey(values['public-key']));
    console.log('release verificado: firma y SHA-256 del HTML correctos');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
