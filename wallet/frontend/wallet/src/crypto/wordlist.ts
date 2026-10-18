// MTW-WORDLIST-V1 ([F-KEY-02], [F-KEY-06]): 65.536 palabras (niceware, MIT; licencia en src/vendor/LICENSE-niceware),
// una por línea. La app la sirve como asset propio con hash de contenido y, al cargarla, verifica su SHA-256 contra el
// valor fijado (el mismo de wallet/config/wordlist/mtw-wordlist-v1.sha256): una lista alterada nunca se usa.
import wordlistUrl from '../vendor/mtw-wordlist-v1.txt?url';

export const WORDLIST_SHA256 = 'c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e';
export const WORDLIST_SIZE = 65_536;

export interface Wordlist {
  readonly words: readonly string[];
  /** Palabra → índice (16 bits). */
  readonly index: ReadonlyMap<string, number>;
}

export function parseWordlist(text: string): Wordlist {
  const words = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (words.length !== WORDLIST_SIZE) throw new Error('MTW-WORDLIST-V1: cantidad de palabras inesperada');
  const index = new Map<string, number>();
  words.forEach((word, i) => {
    if (!/^[a-z]+$/.test(word) || index.has(word)) throw new Error('MTW-WORDLIST-V1: palabra inválida o repetida');
    index.set(word, i);
  });
  return Object.freeze({ words: Object.freeze(words), index });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verifica el SHA-256 fijado antes de interpretar el contenido. */
export async function verifyWordlist(bytes: ArrayBuffer): Promise<Wordlist> {
  if ((await sha256Hex(bytes)) !== WORDLIST_SHA256) throw new Error('MTW-WORDLIST-V1: el SHA-256 no coincide');
  return parseWordlist(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

let loaded: Promise<Wordlist> | null = null;

/** La lista del propio origin, verificada; se carga una sola vez por documento. */
export function loadWordlist(fetcher: typeof fetch = fetch): Promise<Wordlist> {
  loaded ??= fetcher(wordlistUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`MTW-WORDLIST-V1: no se pudo cargar (${String(response.status)})`);
      return response.arrayBuffer();
    })
    .then(verifyWordlist)
    .catch((error: unknown) => {
      loaded = null;
      throw error;
    });
  return loaded;
}
