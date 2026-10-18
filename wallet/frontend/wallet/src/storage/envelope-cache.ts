// "Recordar en este dispositivo" ([F-KEY-07]): opcional, guarda en IndexedDB **sólo el sobre cifrado** de U (la misma
// serialización del archivo de backup), nunca la clave, la Password U ni K. Sin él, el desbloqueo pide el sobre desde
// Drive, archivo o QR. Se valida al leerlo: un sobre alterado o mal formado se descarta.
import { parseEnvelope, serializeEnvelope, type KeyEnvelope } from '../crypto/envelope.ts';

const DB_NAME = 'mtw-wallet';
const STORE = 'envelopes';
const KEY = 'U';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB no disponible'));
    };
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => {
        resolve(request.result);
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('falló IndexedDB'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB abortó la transacción'));
      };
    });
  } finally {
    db.close();
  }
}

export async function rememberEnvelope(envelope: KeyEnvelope): Promise<void> {
  await run('readwrite', (store) => store.put(serializeEnvelope(envelope), KEY));
}

/** El sobre recordado (validado) o null si no hay o no es válido. */
export async function rememberedEnvelope(): Promise<KeyEnvelope | null> {
  try {
    const raw = await run<unknown>('readonly', (store) => store.get(KEY) as IDBRequest<unknown>);
    if (typeof raw !== 'string') return null;
    return parseEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function forgetEnvelope(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY));
}
