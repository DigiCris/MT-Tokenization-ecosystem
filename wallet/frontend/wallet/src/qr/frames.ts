// QR multi-frame ([W-05]): `MTWQR1:<i>/<n>:<sha256 del contenido completo>:<chunk base64url>` con chunks de hasta 600
// caracteres. Se acepta sólo cuando todos los frames reconstruyen un contenido con ese SHA-256. Lo usan el QR del sobre
// cifrado ([F-KEY-06].3) y el intercambio soberano ([F-LNK-03]).
import { fromBase64Url, toBase64Url, toHex, utf8 } from '../crypto/bytes.ts';
import { sha256 } from '../api/session-key.ts';

export const FRAME_PREFIX = 'MTWQR1';
export const MAX_CHUNK = 600;
const FRAME = /^MTWQR1:(\d{1,3})\/(\d{1,3}):([0-9a-f]{64}):([A-Za-z0-9_-]{1,600})$/;

export async function encodeFrames(content: string): Promise<string[]> {
  const bytes = utf8(content);
  const hash = toHex(await sha256(bytes)).slice(2);
  const encoded = toBase64Url(bytes);
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += MAX_CHUNK) chunks.push(encoded.slice(i, i + MAX_CHUNK));
  if (chunks.length > 999) throw new RangeError('contenido demasiado grande para QR');
  return chunks.map((chunk, i) => `${FRAME_PREFIX}:${String(i + 1)}/${String(chunks.length)}:${hash}:${chunk}`);
}

export interface FrameProgress {
  received: number;
  total: number;
}

/** Junta frames (en cualquier orden, con repetidos) y devuelve el contenido cuando está completo y verificado. */
export class FrameCollector {
  #hash: string | null = null;
  #total = 0;
  readonly #chunks = new Map<number, string>();

  /** Agrega un frame leído; lanza si no es un frame MTWQR1 o es de otro contenido que el ya empezado. */
  add(text: string): FrameProgress {
    const match = FRAME.exec(text.trim());
    if (!match) throw new Error('El QR no es un QR de MT Wallet');
    const index = Number(match[1]);
    const total = Number(match[2]);
    const hash = match[3] ?? '';
    if (index < 1 || total < 1 || index > total) throw new Error('Frame de QR inválido');
    if (this.#hash !== null && (hash !== this.#hash || total !== this.#total)) {
      throw new Error('Este QR es de otro contenido: empezá de nuevo');
    }
    this.#hash = hash;
    this.#total = total;
    this.#chunks.set(index, match[4] ?? '');
    return this.progress();
  }

  progress(): FrameProgress {
    return { received: this.#chunks.size, total: this.#total };
  }

  /** El contenido si están todos los frames y el SHA-256 coincide; null si faltan; lanza si no coincide. */
  async content(): Promise<string | null> {
    if (this.#hash === null || this.#chunks.size !== this.#total) return null;
    const encoded = Array.from({ length: this.#total }, (_, i) => this.#chunks.get(i + 1) ?? '').join('');
    const bytes = fromBase64Url(encoded);
    if (toHex(await sha256(bytes)).slice(2) !== this.#hash) {
      throw new Error('Los frames del QR no reconstruyen el contenido original');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}

/** Contenido de un conjunto completo de frames. */
export async function decodeFrames(frames: readonly string[]): Promise<string> {
  const collector = new FrameCollector();
  for (const frame of frames) collector.add(frame);
  const content = await collector.content();
  if (content === null) throw new Error('Faltan frames del QR');
  return content;
}
