// Allowlist de workers generada en el build ([F-SEC-02]): cada URL la resuelve Vite (`?worker&url`) al asset con hash
// de contenido del worker compilado, y es lo único que la política mtw-default acepta en `createScriptURL`.
import argon2WorkerUrl from './argon2.worker.ts?worker&url';

export const WORKER_URLS = { argon2: argon2WorkerUrl } as const;

export const WORKER_ALLOWLIST: readonly string[] = Object.values(WORKER_URLS);
