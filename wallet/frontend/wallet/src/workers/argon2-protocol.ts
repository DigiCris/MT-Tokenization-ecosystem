// Protocolo del worker de Argon2id ([F-KEY-03]): mensajes entre la app y src/workers/argon2.worker.ts y la derivación
// en sí. Argon2id de hash-wasm 4.12.0 (WASM, fijado tras revisión): ADR-013 lo adopta en Wallet porque @noble/hashes
// (JS puro) superó el presupuesto de 3 s p95 en el perfil móvil de referencia (P17.T08). Mismo Argon2id v1.3: los
// sobres creados antes abren igual. Sin globals de DOM ni de worker: lo comparten el worker, la app y los tests.
import { argon2id } from 'hash-wasm';

/** Baseline de V9 para todo sobre: 64 MiB, t=3, p=4, 32 bytes ([F-KEY-03]). */
export const ARGON2_BASELINE = { memoryKiB: 65_536, iterations: 3, parallelism: 4, outputLength: 32 } as const;
/** Opción avanzada de U en desktop (desactivada por defecto). */
export const ARGON2_DESKTOP_MEMORY_KIB = 131_072;

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputLength: number;
}

export interface Argon2Request extends Argon2Params {
  id: number;
  password: Uint8Array;
  salt: Uint8Array;
}

export type Argon2Response =
  { id: number; ok: true; key: Uint8Array; elapsedMs: number } | { id: number; ok: false; error: string };

/** Límites que la app acepta: los parámetros vienen del sobre y un sobre adulterado no puede agotar el dispositivo. */
export function validateArgon2(params: Argon2Params, salt: Uint8Array): void {
  const { memoryKiB, iterations, parallelism, outputLength } = params;
  if (!Number.isSafeInteger(memoryKiB) || memoryKiB < 8 * parallelism || memoryKiB > ARGON2_DESKTOP_MEMORY_KIB) {
    throw new RangeError('memoria de Argon2id fuera de rango');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10) {
    throw new RangeError('iteraciones de Argon2id fuera de rango');
  }
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 8) {
    throw new RangeError('paralelismo de Argon2id fuera de rango');
  }
  if (outputLength !== 32) throw new RangeError('la salida de Argon2id es de 32 bytes');
  if (salt.length < 16) throw new RangeError('salt de Argon2id demasiado corto');
}

export async function deriveArgon2id(request: Omit<Argon2Request, 'id'>): Promise<Uint8Array> {
  validateArgon2(request, request.salt);
  return argon2id({
    password: request.password,
    salt: request.salt,
    parallelism: request.parallelism,
    iterations: request.iterations,
    memorySize: request.memoryKiB,
    hashLength: request.outputLength,
    outputType: 'binary',
  });
}
