// Firma Ed25519 del release manifest de la app Recovery ([W-04], P16.T06): firma los bytes exactos de
// dist/.well-known/release-manifest.json con la clave de release **de esta app** (build/release-keys.ts) y escribe la
// firma en base64 en release-manifest.json.sig. Se niega a firmar si el árbol de la app tiene cambios sin commitear: el
// manifest declara un commit y tiene que corresponderle. La firma se verifica en el acto con la pública derivada.
//
// Uso: node build/sign-manifest.ts [--dist <dir>] [--allow-dirty]
import { execFileSync } from 'node:child_process';
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP, APP_ROOT } from './config.ts';
import { MANIFEST_FILE, SIGNATURE_FILE } from './manifest.ts';
import { releasePrivateKey } from './release-keys.ts';

export function signManifestBytes(bytes: Buffer, privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('la clave de release debe ser Ed25519');
  const signature = sign(null, bytes, privateKey);
  if (!verify(null, bytes, createPublicKey(privateKey), signature)) throw new Error('la firma no verifica');
  return signature.toString('base64');
}

function dirtyPaths(): string[] {
  const out = execFileSync('git', ['status', '--porcelain', '--', '.', '../design-tokens'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { dist: { type: 'string', default: join(APP_ROOT, 'dist') }, 'allow-dirty': { type: 'boolean' } },
  });
  try {
    if (values['allow-dirty'] !== true && dirtyPaths().length > 0) {
      throw new Error('el árbol de la app tiene cambios sin commitear: el manifest no correspondería a su commit');
    }
    const dist = resolve(values.dist);
    const manifest = readFileSync(join(dist, MANIFEST_FILE));
    writeFileSync(join(dist, SIGNATURE_FILE), signManifestBytes(manifest, releasePrivateKey()));
    console.log(`manifest de ${APP} firmado (${SIGNATURE_FILE})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
