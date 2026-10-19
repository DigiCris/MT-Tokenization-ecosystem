// Un chequeo de integridad de una app servida (P20.T02): manifest y firma con la clave de release fijada de esa app,
// cada archivo del manifest por SHA-256 y tamaño, el documento de `/` igual al index.html del manifest, SRI y
// recursos del documento (html.ts), headers de seguridad por ruta contra los del release (headers.ts) y el bloqueo de
// scripts de service worker. Resultado: OK, MISMATCH (algo servido no es el release firmado) o UNREACHABLE (no se pudo
// verificar: red, timeout o error 5xx). Nunca se siguen redirecciones: un archivo redirigido es un MISMATCH.
import type { KeyObject } from 'node:crypto';
import { expectedHeaders, headerProblems, HeaderSpecSchema } from './headers.ts';
import { inspectDocument } from './html.ts';
import {
  HEADERS_FILE,
  MANIFEST_PATH,
  ManifestError,
  parseManifest,
  sha256Hex,
  SIGNATURE_PATH,
  verifyManifestSignature,
  type ReleaseManifest,
} from './manifest.ts';

export type App = 'WALLET' | 'RECOVERY';
export const APPS: readonly App[] = ['WALLET', 'RECOVERY'];
export type Status = 'OK' | 'MISMATCH' | 'UNREACHABLE';

export interface Target {
  app: App;
  /** Origin de la app (sin barra final), p. ej. https://recovery.example. */
  url: string;
}

export interface CheckOptions {
  /** Claves públicas de release fijadas de la app (más de una sólo durante el solapamiento de una rotación). */
  releaseKeys: readonly KeyObject[];
  /** Entorno que tiene que declarar el manifest (local, ci, staging o production). */
  environment: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface CheckResult {
  app: App;
  status: Status;
  releaseId: string | null;
  manifestSha256: string | null;
  problems: string[];
  files: number;
}

class Unreachable extends Error {
  override name = 'Unreachable';
}

const CONCURRENCY = 6;

function parseHeaderSpec(bytes: Uint8Array | undefined) {
  if (bytes === undefined) return undefined;
  try {
    return HeaderSpecSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

export async function checkRelease(target: Target, options: CheckOptions): Promise<CheckResult> {
  const base = target.url.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  let releaseId: string | null = null;
  let manifestSha256: string | null = null;
  let checkedFiles = 0;
  const done = (status: Status, problems: string[]): CheckResult => ({
    app: target.app,
    status,
    releaseId,
    manifestSha256,
    problems,
    files: checkedFiles,
  });

  const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new Unreachable(`${path}: sin respuesta`);
    }
    if (response.status >= 500) throw new Unreachable(`${path}: HTTP ${String(response.status)}`);
    return response;
  };
  const body = async (response: Response): Promise<Uint8Array> => {
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new Unreachable(`${response.url}: respuesta cortada`);
    }
  };

  try {
    const manifestResponse = await get(MANIFEST_PATH);
    if (manifestResponse.status !== 200) {
      return done('MISMATCH', [`manifest: HTTP ${String(manifestResponse.status)}`]);
    }
    const manifestBytes = await body(manifestResponse);
    manifestSha256 = sha256Hex(manifestBytes);
    const signatureResponse = await get(SIGNATURE_PATH);
    if (signatureResponse.status !== 200) {
      return done('MISMATCH', [`firma del manifest: HTTP ${String(signatureResponse.status)}`]);
    }
    const signature = new TextDecoder().decode(await body(signatureResponse));
    if (!options.releaseKeys.some((key) => verifyManifestSignature(manifestBytes, signature, key))) {
      return done('MISMATCH', ['la firma del manifest no verifica con la clave de release fijada']);
    }
    let manifest: ReleaseManifest;
    try {
      manifest = parseManifest(manifestBytes);
    } catch (error) {
      if (error instanceof ManifestError) return done('MISMATCH', [error.message]);
      throw error;
    }
    releaseId = manifest.releaseId;
    const problems: string[] = [];
    if (manifest.app !== target.app.toLowerCase()) problems.push(`el manifest es de la app ${manifest.app}`);
    if (manifest.environment !== options.environment) {
      problems.push(`el manifest es del entorno ${manifest.environment}, no de ${options.environment}`);
    }

    // Archivos del manifest, de a varios a la vez.
    const files = new Map<string, Uint8Array>();
    const queue = [...manifest.files];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
          const response = await get(`/${file.path}`);
          if (response.status !== 200) {
            problems.push(`${file.path}: HTTP ${String(response.status)}`);
            await response.body?.cancel();
            continue;
          }
          const bytes = await body(response);
          checkedFiles++;
          if (bytes.length !== file.size || sha256Hex(bytes) !== file.sha256) {
            problems.push(`${file.path}: el contenido no coincide con el manifest`);
          } else {
            files.set(file.path, bytes);
          }
        }
      }),
    );

    // Documento: el que se sirve en "/" es el index.html del manifest, y su contenido pasa la revisión de SRI.
    const index = files.get('index.html');
    const rootResponse = await get('/');
    const root = await body(rootResponse);
    if (index === undefined) {
      problems.push('index.html no figura en el manifest o no coincide');
    } else {
      if (rootResponse.status !== 200 || sha256Hex(root) !== sha256Hex(index)) {
        problems.push('/: el documento servido no es el index.html del manifest');
      }
      const listed = new Set(manifest.files.map((f) => f.path));
      problems.push(...inspectDocument(new TextDecoder().decode(index), listed, files));
    }

    // Headers de seguridad declarados por el release, por ruta.
    const spec = parseHeaderSpec(files.get(HEADERS_FILE));
    if (spec === undefined || !spec.success) {
      problems.push(`${HEADERS_FILE} no figura en el manifest o no tiene el formato esperado`);
    } else {
      problems.push(...headerProblems('/', rootResponse.headers, expectedHeaders(spec.data, '/')));
      const asset = manifest.files.find((f) => f.path.startsWith('assets/'));
      const probes = [
        ...Object.keys(spec.data.routes).slice(0, 1),
        MANIFEST_PATH,
        ...(asset ? [`/${asset.path}`] : []),
      ];
      for (const path of probes) {
        const response = await get(path);
        await response.body?.cancel();
        problems.push(...headerProblems(path, response.headers, expectedHeaders(spec.data, path)));
      }
    }
    const serviceWorker = await get('/', { 'Service-Worker': 'script' });
    await serviceWorker.body?.cancel();
    if (serviceWorker.status !== 403) problems.push('un pedido de script de service worker no devuelve 403');

    return done(problems.length === 0 ? 'OK' : 'MISMATCH', problems);
  } catch (error) {
    if (error instanceof Unreachable) return done('UNREACHABLE', [error.message]);
    throw error;
  }
}
