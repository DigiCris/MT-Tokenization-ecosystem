// MTW-WORDLIST-V1 ([F-KEY-02], ADR-013): niceware 4.0.0, 65.536 palabras (16 bits cada una). La copia de esta app vive
// en src/vendor/ (igual a wallet/config/wordlist, test/unit/wordlist-copy.test.ts); se carga como asset del build y se
// verifica contra el SHA-256 fijado antes de usarla: una lista alterada nunca genera Password R ni lee 17 palabras. El
// parseo y la normalización (sin imports del build) están en words.ts.
import wordlistUrl from '../vendor/mtw-wordlist-v1.txt?url';
import { bytesToHex, fromUtf8, toBufferSource } from './encoding.ts';
import { parseWordlist, WordlistError, type Wordlist } from './words.ts';

export { normalizeWord, parseWordlist, WORDLIST_SIZE, WordlistError, type Wordlist } from './words.ts';

/** wallet/config/wordlist/mtw-wordlist-v1.sha256 */
export const WORDLIST_SHA256 = '0xc2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e';

/** Verifica el SHA-256 de los bytes contra el valor fijado y recién entonces los interpreta. */
export async function verifiedWordlist(bytes: Uint8Array): Promise<Wordlist> {
  const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(bytes))));
  if (digest !== WORDLIST_SHA256) throw new WordlistError('la lista de palabras no coincide con la fijada');
  return parseWordlist(fromUtf8(bytes));
}

let loading: Promise<Wordlist> | null = null;

/** La lista del build (una sola descarga por pestaña). */
export function loadWordlist(fetcher: typeof fetch = fetch): Promise<Wordlist> {
  loading ??= fetcher(wordlistUrl)
    .then(async (response) => {
      if (!response.ok) throw new WordlistError('no se pudo cargar la lista de palabras');
      return verifiedWordlist(new Uint8Array(await response.arrayBuffer()));
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
