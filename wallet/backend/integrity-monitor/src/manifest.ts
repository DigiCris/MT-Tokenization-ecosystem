// Release manifest firmado ([W-04]): `{app, environment, releaseId, gitCommit, sourceDateEpoch, files}` en JSON canónico
// (JCS), firmado con Ed25519 sobre los bytes exactos del archivo; la firma va en base64 en release-manifest.json.sig.
// El monitor verifica la firma con la clave pública de release **fijada** de cada app (config/release-keys/), nunca con
// una que informe el sitio.
import { createHash, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalize, type Json } from './jcs.ts';

export const MANIFEST_PATH = '/.well-known/release-manifest.json';
export const SIGNATURE_PATH = '/.well-known/release-manifest.json.sig';
export const HEADERS_FILE = '.well-known/security-headers.json';

const FileSchema = z
  .object({
    // Ruta relativa dentro del sitio, sin `..` ni barra inicial.
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._~\-/@]+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();

const ManifestSchema = z
  .object({
    app: z.enum(['wallet', 'recovery']),
    environment: z.string().regex(/^[a-z]{2,16}$/),
    releaseId: z.string().min(1).max(128),
    gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
    sourceDateEpoch: z.number().int().nonnegative(),
    files: z.array(FileSchema).min(1).max(5_000),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ManifestSchema>;
export type ManifestFile = ReleaseManifest['files'][number];

export class ManifestError extends Error {
  override name = 'ManifestError';
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyManifestSignature(bytes: Uint8Array, signatureBase64: string, key: KeyObject): boolean {
  const text = signatureBase64.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  return verify(null, bytes, key, Buffer.from(text, 'base64'));
}

/** Parsea el manifest y exige que sus bytes sean exactamente su forma canónica (JCS) y que las rutas no se repitan. */
export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ManifestError('el manifest no es JSON UTF-8 válido');
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError('el manifest no tiene el formato [W-04]');
  if (canonicalize(raw as Json) !== new TextDecoder().decode(bytes)) {
    throw new ManifestError('el manifest no está en JSON canónico (JCS)');
  }
  const paths = new Set(parsed.data.files.map((f) => f.path));
  if (paths.size !== parsed.data.files.length) throw new ManifestError('el manifest repite rutas');
  return parsed.data;
}
