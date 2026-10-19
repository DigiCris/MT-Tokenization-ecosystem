// P19.T02: la copia de MTW-WORDLIST-V1 de Recovery (src/vendor/) es byte a byte la de wallet/config/wordlist, con su
// licencia, y el hash que fija el código es el del archivo de referencia.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(import.meta.dirname, '../..');
const REFERENCE = resolve(APP, '../../config/wordlist');

describe('copia de la lista de palabras', () => {
  it('igual a la de referencia (lista, licencia y archivo de hash)', () => {
    for (const file of ['mtw-wordlist-v1.txt', 'LICENSE-niceware', 'mtw-wordlist-v1.sha256']) {
      expect(readFileSync(resolve(APP, 'src/vendor', file)).equals(readFileSync(resolve(REFERENCE, file))), file).toBe(
        true,
      );
    }
  });

  it('el hash fijado en el código es el del archivo de referencia', () => {
    const pinned = readFileSync(resolve(REFERENCE, 'mtw-wordlist-v1.sha256'), 'utf8').split(/\s+/)[0];
    const actual = createHash('sha256')
      .update(readFileSync(resolve(APP, 'src/vendor/mtw-wordlist-v1.txt')))
      .digest('hex');
    expect(actual).toBe(pinned);
    const source = readFileSync(resolve(APP, 'src/crypto/wordlist.ts'), 'utf8');
    expect(/WORDLIST_SHA256 = '0x([0-9a-f]{64})'/.exec(source)?.[1]).toBe(actual);
  });
});
