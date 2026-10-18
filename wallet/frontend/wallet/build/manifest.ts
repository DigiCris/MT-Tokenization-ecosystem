// Release manifest de la app Wallet ([W-04], [F-SEC-06], P16.T06): al cerrar el build recorre dist/ y escribe
// dist/.well-known/release-manifest.json en JSON canónico (JCS) con {app, environment, releaseId, gitCommit,
// sourceDateEpoch, files: [{path, sha256, size}]}. Determinístico: sin timestamps propios (la fecha es la del commit,
// SOURCE_DATE_EPOCH), archivos ordenados y nombres con hash de contenido. La firma la agrega build/sign-manifest.ts.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import type { BuildConfig } from './config.ts';
import { canonicalize } from './jcs.ts';

export const MANIFEST_FILE = '.well-known/release-manifest.json';
export const SIGNATURE_FILE = '.well-known/release-manifest.json.sig';
/** Fuera del manifest: el propio manifest, su firma y el SBOM (se genera después y no es determinístico). */
const EXCLUDED = new Set([MANIFEST_FILE, SIGNATURE_FILE, 'sbom.cdx.json']);

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  app: string;
  environment: string;
  releaseId: string;
  gitCommit: string;
  sourceDateEpoch: number;
  files: ManifestFile[];
}

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, root);
    if (!entry.isFile()) throw new Error(`manifest: ${full} no es un archivo regular`);
    return [relative(root, full).split(sep).join('/')];
  });
}

export function manifestOf(
  dir: string,
  config: Pick<ReleaseManifest, 'app' | 'environment' | 'releaseId' | 'gitCommit' | 'sourceDateEpoch'>,
): ReleaseManifest {
  const files = walk(dir)
    .filter((path) => !EXCLUDED.has(path))
    .sort()
    .map((path) => {
      const bytes = readFileSync(join(dir, path));
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
  return {
    app: config.app,
    environment: config.environment,
    releaseId: config.releaseId,
    gitCommit: config.gitCommit,
    sourceDateEpoch: config.sourceDateEpoch,
    files,
  };
}

export function serializeManifest(manifest: ReleaseManifest): string {
  return canonicalize({ ...manifest, files: manifest.files.map((f) => ({ ...f })) });
}

export function manifestPlugin(config: BuildConfig): Plugin {
  let outDir = '';
  return {
    name: 'mtw:release-manifest',
    apply: 'build',
    configResolved(resolved) {
      outDir = resolved.build.outDir.startsWith('/')
        ? resolved.build.outDir
        : join(resolved.root, resolved.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const manifest = manifestOf(outDir, config);
        mkdirSync(join(outDir, '.well-known'), { recursive: true });
        writeFileSync(join(outDir, MANIFEST_FILE), serializeManifest(manifest));
      },
    },
  };
}
