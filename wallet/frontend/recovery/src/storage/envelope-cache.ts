// "Recordar en este dispositivo" ([F-KEY-07]): sólo el sobre cifrado `R.enc` (nunca R ni la Password R) en IndexedDB,
// uno por clave de cada wallet: en un reemplazo de R conviven el de la R vigente y el de R′, porque hasta que el
// reemplazo se ejecute (48 h) la vigente es la que cancela rotaciones desde acá. Es una comodidad: el backup
// independiente de la plataforma sigue siendo obligatorio. También la Safe que R ya verificó (dato público): el modo
// soberano la propone sin preguntarle al backend. El sobre de una R que no es firmante de la Safe (de un pedido anterior)
// se puede olvidar solo, sin tocar los demás de la wallet (cuarta revisión de P17.MAN, hallazgo 12).
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
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

/** Dónde se guarda el sobre: su wallet y la dirección de su clave (antes, sólo la wallet). */
function envelopeKey(envelope: RecoveryEnvelope): string {
  return `${envelope.walletId}:${envelope.keyAddress.toLowerCase()}`;
}

export async function rememberEnvelope(envelope: RecoveryEnvelope): Promise<void> {
  await run(ENVELOPES, 'readwrite', (store) => store.put(JSON.stringify(envelope), envelopeKey(envelope)));
}

/** Borra todos los sobres recordados de la wallet (también uno guardado con la clave anterior, sólo la wallet). */
export async function forgetEnvelope(walletId: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ENVELOPES, 'readwrite');
      const cursor = transaction.objectStore(ENVELOPES).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) return;
        const key = typeof current.key === 'string' ? current.key : '';
        if (key === walletId || key.startsWith(`${walletId}:`)) current.delete();
        current.continue();
      };
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB falló'));
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Olvida el sobre recordado de esa R de esa wallet (también uno guardado con la clave anterior, sólo la wallet); los de
 * otras R quedan.
 */
export async function forgetRememberedEnvelope(walletId: string, keyAddress: Address): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ENVELOPES, 'readwrite');
      const cursor = transaction.objectStore(ENVELOPES).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) return;
        try {
          const value: unknown = current.value;
          const envelope = parseRecoveryEnvelope(JSON.parse(typeof value === 'string' ? value : ''));
          if (envelope.walletId === walletId && isAddressEqual(envelope.keyAddress, keyAddress)) current.delete();
        } catch {
          // Uno que ya no valida no es el de esa R.
        }
        current.continue();
      };
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB falló'));
      };
    });
  } finally {
    db.close();
  }
}

/** Si este dispositivo recuerda el sobre de esa R de esa wallet. */
export async function isRememberedEnvelope(walletId: string, keyAddress: Address): Promise<boolean> {
  return (await rememberedEnvelopes()).some((e) => e.walletId === walletId && isAddressEqual(e.keyAddress, keyAddress));
}

/** Los sobres recordados (válidos), uno por clave de cada wallet; uno corrupto se ignora. */
export async function rememberedEnvelopes(): Promise<RecoveryEnvelope[]> {
  const values = await run<unknown[]>(ENVELOPES, 'readonly', (store) => store.getAll());
  const envelopes = new Map<string, RecoveryEnvelope>();
  for (const value of values) {
    try {
      if (typeof value !== 'string') continue;
      const envelope = parseRecoveryEnvelope(JSON.parse(value));
      envelopes.set(envelopeKey(envelope), envelope);
    } catch {
      // Un sobre que ya no valida no se ofrece.
    }
  }
  return [...envelopes.values()];
}

/** La Safe que R verificó on-chain (RecoveryGate), por dirección de R. */
export async function rememberSafe(recoveryKey: Address, safe: Address): Promise<void> {
  await run(SAFES, 'readwrite', (store) => store.put(getAddress(safe), recoveryKey.toLowerCase()));
}

export async function rememberedSafe(recoveryKey: Address): Promise<Address | null> {
  const value = await run<unknown>(SAFES, 'readonly', (store) => store.get(recoveryKey.toLowerCase()));
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
}
