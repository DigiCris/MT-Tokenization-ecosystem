// Firma del release de la herramienta: `dist/SHA256SUMS` (hash del HTML) firmado con Ed25519 en `SHA256SUMS.sig`
// (base64). Se niega a firmar con cambios sin commitear en la herramienta: el release tiene que corresponder a su
// commit. La firma se verifica en el acto con la pública derivada.
//
// Uso: node scripts/sign-release.ts [--dist <dir>] [--allow-dirty]
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releasePrivateKey } from './release-keys.ts';

export const SUMS = 'SHA256SUMS';
export const SIGNATURE = 'SHA256SUMS.sig';
export const HTML = 'sovereign-exit.html';

export function sums(dist: string): string {
  const digest = createHash('sha256')
    .update(readFileSync(join(dist, HTML)))
    .digest('hex');
  return `${digest}  ${HTML}\n`;
}

export function signRelease(dist: string, key: KeyObject): void {
  const content = Buffer.from(sums(dist), 'utf8');
  const signature = sign(null, content, key);
  if (!verify(null, content, createPublicKey(key), signature)) throw new Error('la firma no verifica');
  writeFileSync(join(dist, SUMS), content);
  writeFileSync(join(dist, SIGNATURE), `${signature.toString('base64')}\n`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const { values } = parseArgs({
    options: { dist: { type: 'string', default: join(root, 'dist') }, 'allow-dirty': { type: 'boolean' } },
  });
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' }).trim();
    if (values['allow-dirty'] !== true && dirty !== '') {
      throw new Error('la herramienta tiene cambios sin commitear: el release no correspondería a su commit');
    }
    signRelease(resolve(values.dist), releasePrivateKey());
    console.log(`release firmado (${SUMS} y ${SIGNATURE})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
