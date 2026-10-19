// "Recordar en este dispositivo" ([F-KEY-07]): sólo el sobre cifrado `R.enc` (nunca R ni la Password R) en IndexedDB,
// uno por wallet. Es una comodidad: el backup independiente de la plataforma sigue siendo obligatorio. También la Safe
// que R ya verificó (dato público): el modo soberano la propone sin preguntarle al backend.
import { getAddress, isAddress, type Address } from 'viem';
import { parseRecoveryEnvelope, type RecoveryEnvelope } from '../crypto/envelope.ts';

const DB_NAME = 'mtw-recovery';
const DB_VERSION = 2;
const ENVELOPES = 'envelopes';
const SAFES = 'safes';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [ENVELOPES, SAFES]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB no disponible'));
    };
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (target: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB falló'));
      };
    });
  } finally {
    db.close();
  }
}

export async function rememberEnvelope(envelope: RecoveryEnvelope): Promise<void> {
  await run(ENVELOPES, 'readwrite', (store) => store.put(JSON.stringify(envelope), envelope.walletId));
}

export async function forgetEnvelope(walletId: string): Promise<void> {
  await run(ENVELOPES, 'readwrite', (store) => store.delete(walletId));
}

/** Los sobres recordados (válidos); uno corrupto se ignora. */
export async function rememberedEnvelopes(): Promise<RecoveryEnvelope[]> {
  const values = await run<unknown[]>(ENVELOPES, 'readonly', (store) => store.getAll());
  const envelopes: RecoveryEnvelope[] = [];
  for (const value of values) {
    try {
      if (typeof value === 'string') envelopes.push(parseRecoveryEnvelope(JSON.parse(value)));
    } catch {
      // Un sobre que ya no valida no se ofrece.
    }
  }
  return envelopes;
}

/** La Safe que R verificó on-chain (RecoveryGate), por dirección de R. */
export async function rememberSafe(recoveryKey: Address, safe: Address): Promise<void> {
  await run(SAFES, 'readwrite', (store) => store.put(getAddress(safe), recoveryKey.toLowerCase()));
}

export async function rememberedSafe(recoveryKey: Address): Promise<Address | null> {
  const value = await run<unknown>(SAFES, 'readonly', (store) => store.get(recoveryKey.toLowerCase()));
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
}
