// Worker dedicado de Argon2id ([F-KEY-03]): deriva fuera del hilo de la UI con hash-wasm (ADR-013) y devuelve la clave
// transfiriendo el buffer. La password recibida se sobrescribe con ceros al terminar (best-effort, [F-KEY-05]). Se
// carga sólo con una TrustedScriptURL de la política mtw-default (src/workers/argon2-client.ts).
import { deriveArgon2id, type Argon2Request, type Argon2Response } from './argon2-protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent<Argon2Request>) => {
  const request = event.data;
  const started = performance.now();
  deriveArgon2id(request)
    .then((key) => {
      const response: Argon2Response = { id: request.id, ok: true, key, elapsedMs: performance.now() - started };
      self.postMessage(response, [key.buffer]);
    })
    .catch((error: unknown) => {
      const response: Argon2Response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'error de derivación',
      };
      self.postMessage(response);
    })
    .finally(() => {
      request.password.fill(0);
    });
});
