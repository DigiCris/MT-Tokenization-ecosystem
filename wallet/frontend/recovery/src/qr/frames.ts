// QR multi-cuadro [W-05] de Recovery (implementación propia del formato común con la Wallet): el contenido (JCS de un
// documento soberano o el JSON de un sobre) va en base64url partido en cuadros
// `MTWQR1:<i>/<n>:<sha256 hex del contenido>:<trozo base64url ≤ 600>`. El lector junta los cuadros en cualquier orden y
// sólo devuelve el contenido si reconstruye el SHA-256 anunciado.
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, fromUtf8, toBufferSource, utf8 } from '../crypto/encoding.ts';

export const FRAME_PREFIX = 'MTWQR1';
export const MAX_CHUNK = 600;
const FRAME = /^MTWQR1:(\d{1,3})\/(\d{1,3}):([0-9a-f]{64}):([A-Za-z0-9_-]{1,600})$/;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(bytes)))).slice(2);
}

export class FrameError extends Error {
  override name = 'FrameError';
}

export async function encodeFrames(content: string): Promise<string[]> {
  const bytes = utf8(content);
  const hash = await sha256Hex(bytes);
  const encoded = bytesToBase64Url(bytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += MAX_CHUNK)
    chunks.push(encoded.slice(offset, offset + MAX_CHUNK));
  if (chunks.length === 0 || chunks.length > 999) throw new FrameError('el contenido no entra en un QR multi-cuadro');
  return chunks.map((chunk, i) => `${FRAME_PREFIX}:${String(i + 1)}/${String(chunks.length)}:${hash}:${chunk}`);
}

export interface FrameProgress {
  received: number;
  total: number;
}

/** Junta cuadros leídos por la cámara (en cualquier orden y repetidos); `content()` valida el hash al completar. */
export class FrameCollector {
  #total = 0;
  #hash: string | null = null;
  readonly #chunks = new Map<number, string>();

  /** Un cuadro leído; null si no es un cuadro MTWQR1 (otro QR delante de la cámara). Uno de otro contenido reinicia. */
  add(text: string): FrameProgress | null {
    const match = FRAME.exec(text.trim());
    if (!match) return null;
    const index = Number(match[1]);
    const total = Number(match[2]);
    const hash = match[3] ?? '';
    if (total < 1 || index < 1 || index > total) return null;
    if (this.#hash !== null && (hash !== this.#hash || total !== this.#total)) this.#chunks.clear();
    this.#total = total;
    this.#hash = hash;
    this.#chunks.set(index, match[4] ?? '');
    return { received: this.#chunks.size, total };
  }

  /** El contenido completo y verificado, o null mientras faltan cuadros. */
  async content(): Promise<string | null> {
    if (this.#hash === null || this.#chunks.size !== this.#total) return null;
    const encoded = Array.from({ length: this.#total }, (_, i) => this.#chunks.get(i + 1) ?? '').join('');
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(encoded);
    } catch {
      throw new FrameError('los cuadros del QR no forman un contenido válido');
    }
    if ((await sha256Hex(bytes)) !== this.#hash) throw new FrameError('los cuadros del QR no reconstruyen su hash');
    return fromUtf8(bytes);
  }
}

export async function decodeFrames(frames: readonly string[]): Promise<string> {
  const collector = new FrameCollector();
  for (const frame of frames) {
    if (collector.add(frame) === null) throw new FrameError('un cuadro no tiene el formato MTWQR1');
  }
  const content = await collector.content();
  if (content === null) throw new FrameError('faltan cuadros del QR');
  return content;
}
