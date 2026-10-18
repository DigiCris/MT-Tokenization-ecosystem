// Verificación del release de la app Wallet ([W-04], P16.T06): firma Ed25519 del manifest con la clave pública de
// release de esta app (build/release-keys.ts) y que cada archivo de dist/ figure en el manifest con su SHA-256 y
// tamaño, sin archivos de más ni de menos.
//
// Uso: node build/verify-manifest.ts [--dist <dir>] [--public-key <pem|der>]
import { verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP, APP_ROOT } from './config.ts';
import { MANIFEST_FILE, manifestOf, serializeManifest, SIGNATURE_FILE, type ReleaseManifest } from './manifest.ts';
import { releasePublicKey } from './release-keys.ts';

export function verifyRelease(dist: string, publicKey: KeyObject): ReleaseManifest {
  const bytes = readFileSync(join(dist, MANIFEST_FILE));
  const signature = Buffer.from(readFileSync(join(dist, SIGNATURE_FILE), 'utf8').trim(), 'base64');
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('la clave pública de release debe ser Ed25519');
  if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new Error('la firma del manifest no verifica con la clave pública de release');
  }
  const text = bytes.toString('utf8');
  const manifest = JSON.parse(text) as ReleaseManifest;
  if (manifest.app !== APP) throw new Error(`el manifest es de ${manifest.app}, no de ${APP}`);
  if (serializeManifest(manifest) !== text) throw new Error('el manifest no está en JSON canónico');
  const actual = manifestOf(dist, manifest);
  if (serializeManifest(actual) !== text) {
    const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
    const found = new Map(actual.files.map((f) => [f.path, f.sha256]));
    const problems = [
      ...[...found.keys()].filter((p) => !listed.has(p)).map((p) => `no listado: ${p}`),
      ...[...listed.keys()].filter((p) => !found.has(p)).map((p) => `falta: ${p}`),
      ...[...found].filter(([p, h]) => listed.has(p) && listed.get(p) !== h).map(([p]) => `hash distinto: ${p}`),
    ];
    throw new Error(`dist/ no coincide con el manifest: ${problems.join(', ')}`);
  }
  return manifest;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { dist: { type: 'string', default: join(APP_ROOT, 'dist') }, 'public-key': { type: 'string' } },
  });
  try {
    const manifest = verifyRelease(resolve(values.dist), releasePublicKey(values['public-key']));
    console.log(`release ${manifest.releaseId} verificado: firma OK y ${String(manifest.files.length)} archivos`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
