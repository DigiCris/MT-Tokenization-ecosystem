// Lista de passwords comunes vendorizada (data/common-passwords, SecLists NCSC 100k en un commit fijado). Se carga al
// primer uso y se verifica su SHA-256: una lista alterada detiene el registro en lugar de aceptar passwords débiles.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { codePointLength } from './password.ts';

export const VENDORED_LIST_SHA256 = 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0';
const DATA = new URL('../../data/common-passwords/100k-most-used-passwords-NCSC.txt.gz', import.meta.url);

const cache = new Map<number, ReadonlySet<string>>();

/** Passwords comunes normalizadas (NFKC, minúsculas) de al menos `minLength` caracteres. */
export function commonPasswords(minLength: number): ReadonlySet<string> {
  const cached = cache.get(minLength);
  if (cached) return cached;
  const content = gunzipSync(readFileSync(DATA));
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== VENDORED_LIST_SHA256) {
    throw new Error('la lista de passwords comunes no coincide con el SHA-256 fijado (data/common-passwords)');
  }
  const entries = content
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().normalize('NFKC').toLowerCase())
    .filter((line) => codePointLength(line) >= minLength);
  const set: ReadonlySet<string> = new Set(entries);
  cache.set(minLength, set);
  return set;
}
