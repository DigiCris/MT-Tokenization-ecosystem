// Cliente REST de Drive v3 para la carpeta privada de Recovery ([F-DRV-02]): sólo `fetch` contra www.googleapis.com con
// el token en memoria; listar en `appDataFolder` (por nombre o todo), crear y reemplazar con subida multipart, leer con
// `alt=media` y borrar. `uploadVerified` vuelve a descargar lo subido y lo compara byte a byte. El backend nunca ve el
// token ni el contenido ([F-DRV-04]).
import { utf8 } from '../crypto/encoding.ts';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,size,md5Checksum,modifiedTime';
/** Páginas de 100 que se recorren como máximo al listar toda la carpeta. */
const MAX_PAGES = 10;

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
}

export type DriveErrorCode =
  'NOT_CONNECTED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'NETWORK' | 'UNEXPECTED' | 'MISMATCH';

export class DriveError extends Error {
  override name = 'DriveError';
  readonly code: DriveErrorCode;
  readonly status: number | null;

  constructor(code: DriveErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function codeOf(status: number): DriveErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNEXPECTED';
}

function isDriveFile(value: unknown): value is DriveFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DriveFile).id === 'string' &&
    typeof (value as DriveFile).name === 'string'
  );
}

/** Nombre de archivo de la carpeta de la app: sin comillas ni barras (va dentro de la query `name='…'`). */
function assertName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new TypeError(`nombre de archivo de Drive inválido: ${name}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class DriveClient {
  readonly #token: () => string | null;
  readonly #fetch: typeof fetch;

  constructor(token: () => string | null, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#token = token;
    this.#fetch = fetcher;
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.#token();
    if (token === null) throw new DriveError('NOT_CONNECTED', 'Conectá Google Drive para continuar');
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DriveError('NETWORK', 'No se pudo contactar a Google Drive');
    }
    if (!response.ok) {
      const code = codeOf(response.status);
      throw new DriveError(
        code,
        code === 'UNAUTHORIZED'
          ? 'La conexión con Google Drive venció: volvé a conectarla'
          : `Google Drive respondió ${String(response.status)}`,
        response.status,
      );
    }
    return response;
  }

  async #json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#request(url, init);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DriveError('UNEXPECTED', 'Google Drive devolvió una respuesta inválida');
    }
  }

  async #page(query: Record<string, string>): Promise<{ files: DriveFile[]; next: string | null }> {
    const url = new URL(`${DRIVE_API}/files`);
    url.search = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: `nextPageToken,files(${FIELDS})`,
      orderBy: 'modifiedTime desc',
      ...query,
    }).toString();
    const body = (await this.#json(url.toString())) as { files?: unknown; nextPageToken?: unknown };
    if (!Array.isArray(body.files) || !body.files.every(isDriveFile)) {
      throw new DriveError('UNEXPECTED', 'Google Drive devolvió una lista inválida');
    }
    return { files: body.files, next: typeof body.nextPageToken === 'string' ? body.nextPageToken : null };
  }

  /** Archivos de la carpeta de la app con ese nombre (el más reciente primero). */
  async list(name: string): Promise<DriveFile[]> {
    assertName(name);
    return (await this.#page({ q: `name='${name}' and trashed=false`, pageSize: '10' })).files;
  }

  /** Los archivos de la carpeta de la app que cumplen `match` (recorre hasta MAX_PAGES páginas). */
  async listMatching(match: (name: string) => boolean): Promise<DriveFile[]> {
    const found: DriveFile[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: { files: DriveFile[]; next: string | null } = await this.#page({
        q: 'trashed=false',
        pageSize: '100',
        ...(pageToken === null ? {} : { pageToken }),
      });
      found.push(...result.files.filter((file) => match(file.name)));
      if (result.next === null) break;
      pageToken = result.next;
    }
    return found;
  }

  async find(name: string): Promise<DriveFile | null> {
    return (await this.list(name))[0] ?? null;
  }

  async download(id: string): Promise<Uint8Array> {
    const response = await this.#request(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async #upload(method: 'POST' | 'PATCH', url: string, metadata: object, content: Uint8Array, mime: string) {
    const boundary = `mtw-${crypto.randomUUID()}`;
    const head = utf8(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    );
    const tail = utf8(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + content.length + tail.length);
    body.set(head);
    body.set(content, head.length);
    body.set(tail, head.length + content.length);
    const file = await this.#json(url, {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!isDriveFile(file)) throw new DriveError('UNEXPECTED', 'Google Drive no devolvió el archivo subido');
    return file;
  }

  async create(name: string, content: Uint8Array, mime = 'application/json'): Promise<DriveFile> {
    assertName(name);
    return this.#upload(
      'POST',
      `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`,
      { name, parents: ['appDataFolder'], mimeType: mime },
      content,
      mime,
    );
  }

  async update(id: string, content: Uint8Array, mime = 'application/json'): Promise<DriveFile> {
    return this.#upload(
      'PATCH',
      `${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${FIELDS}`,
      { mimeType: mime },
      content,
      mime,
    );
  }

  async remove(id: string): Promise<void> {
    await this.#request(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * Crea o reemplaza `name` con `content` y lo verifica: lo descarga de nuevo y exige los mismos bytes. Si quedaron
   * copias viejas con el mismo nombre (subidas interrumpidas), se borran después de verificar la nueva.
   */
  async uploadVerified(name: string, content: Uint8Array): Promise<{ file: DriveFile; replaced: boolean }> {
    const existing = await this.list(name);
    const [target, ...stale] = existing;
    const replaced = target ? await this.#replace(target.id, content) : null;
    const file = replaced ?? (await this.create(name, content));
    const stored = await this.download(file.id);
    if (!equalBytes(stored, content)) {
      throw new DriveError('MISMATCH', 'El archivo en Drive no coincide con lo subido: no se dio por guardado');
    }
    for (const old of stale) await this.remove(old.id);
    return { file, replaced: replaced !== null };
  }

  /**
   * Reemplaza el contenido de un archivo listado; null si desapareció entre el listado y la subida (borrado desde otro
   * dispositivo o desde la configuración de Google): entonces se crea de nuevo en lugar de fallar.
   */
  async #replace(id: string, content: Uint8Array): Promise<DriveFile | null> {
    try {
      return await this.update(id, content);
    } catch (error) {
      if (error instanceof DriveError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
}
