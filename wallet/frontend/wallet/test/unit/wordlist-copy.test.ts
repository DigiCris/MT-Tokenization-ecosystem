// [F-KEY-02]: la copia de MTW-WORDLIST-V1 de la app (src/vendor) es byte a byte la de wallet/config/wordlist y su
// SHA-256 es el fijado en el código que la verifica al cargarla.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, WALLET_ROOT } from '../../build/config.ts';
import { WORDLIST_SHA256 } from '../../src/crypto/wordlist.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const firstField = (path: string) => readFileSync(path, 'utf8').split(/\s+/)[0];

describe('copia de MTW-WORDLIST-V1', () => {
  it('es la de config/wordlist, con el SHA-256 fijado en ambos lados', () => {
    const vendored = readFileSync(resolve(APP_ROOT, 'src/vendor/mtw-wordlist-v1.txt'));
    const source = readFileSync(resolve(WALLET_ROOT, 'config/wordlist/mtw-wordlist-v1.txt'));
    expect(vendored.equals(source)).toBe(true);
    expect(sha256(vendored)).toBe(WORDLIST_SHA256);
    expect(firstField(resolve(WALLET_ROOT, 'config/wordlist/mtw-wordlist-v1.sha256'))).toBe(WORDLIST_SHA256);
    expect(firstField(resolve(APP_ROOT, 'src/vendor/mtw-wordlist-v1.sha256'))).toBe(WORDLIST_SHA256);
  });

  it('la licencia de niceware viaja con la copia', () => {
    expect(readFileSync(resolve(APP_ROOT, 'src/vendor/LICENSE-niceware'), 'utf8')).toMatch(/MIT/);
  });
});
