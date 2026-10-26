// Canarios de secretos (P17.SEC, P22.T03): lo que tiene que quedar sólo en memoria no aparece en ningún storage del
// navegador (localStorage, sessionStorage, IndexedDB y cookies) ni en ningún request (URL, headers y cuerpo).
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { toHex } from '../../frontend/wallet/src/crypto/bytes.ts';

export interface Captured {
  url: string;
  headers: string;
  body: string;
}

/** Todos los requests de la página (también los que van a Google). */
export function captureRequests(page: Page): Captured[] {
  const requests: Captured[] = [];
  page.on('request', (request) => {
    const buffer = request.postDataBuffer();
    requests.push({
      url: request.url(),
      headers: JSON.stringify(request.headers()),
      body: buffer ? buffer.toString('latin1') : '',
    });
  });
  return requests;
}

export async function storages(page: Page, context: BrowserContext): Promise<string> {
  const web = await page.evaluate(async () => {
    const dump: string[] = [];
    for (const area of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i) ?? '';
        dump.push(`${key}=${area.getItem(key) ?? ''}`);
      }
    }
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        const request = indexedDB.open(info.name ?? '');
        request.onsuccess = () => {
          resolveDb(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB'));
        };
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolveValues, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => {
            resolveValues(request.result as unknown[]);
          };
          request.onerror = () => {
            reject(request.error ?? new Error('indexedDB'));
          };
        });
        dump.push(`${info.name}/${store}=${JSON.stringify(values)}`);
      }
      db.close();
    }
    return dump.join('\n');
  });
  const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('\n');
  return `${web}\n${cookies}`;
}

export function variants(key: Uint8Array): string[] {
  const hex = toHex(key).slice(2);
  const b64 = Buffer.from(key).toString('base64');
  const b64url = Buffer.from(key).toString('base64url');
  return [hex, hex.toUpperCase(), b64, b64url];
}

export function assertAbsent(haystack: string, canaries: Record<string, string[]>, where: string): void {
  for (const [name, values] of Object.entries(canaries)) {
    for (const value of values) {
      if (value.length < 8) continue;
      expect(haystack.includes(value), `${name} aparece en ${where}`).toBe(false);
    }
  }
}
