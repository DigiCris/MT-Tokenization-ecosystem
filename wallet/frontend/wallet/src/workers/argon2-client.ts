// Cliente del worker de Argon2id: crea el worker con la TrustedScriptURL de la allowlist (createTrustedWorker),
// transfiere la password y espera la clave. Un worker por derivación: se termina
// apenas responde para no dejar la memoria de Argon2id viva.
import { createTrustedWorker } from '../security/trusted-types.ts';
import type { Argon2Params, Argon2Request, Argon2Response } from './argon2-protocol.ts';
import { WORKER_URLS } from './registry.ts';

export interface Argon2Result {
  key: Uint8Array;
  elapsedMs: number;
}

let nextId = 1;

export function runArgon2id(params: Argon2Params & { password: Uint8Array; salt: Uint8Array }): Promise<Argon2Result> {
  const worker = createTrustedWorker(WORKER_URLS.argon2, { type: 'module', name: 'argon2' });
  const id = nextId++;
  return new Promise<Argon2Result>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<Argon2Response>) => {
      const response = event.data;
      if (response.id !== id) return;
      worker.terminate();
      if (response.ok) resolve({ key: response.key, elapsedMs: response.elapsedMs });
      else reject(new Error(response.error));
    });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(new Error(event.message || 'el worker de Argon2id no cargó'));
    });
    const request: Argon2Request = { id, ...params };
    worker.postMessage(request, [params.password.buffer]);
  });
}
