// Efectos de las operaciones ejecutadas (P14), en un lazo del worker separado del pipeline (que nunca espera por
// ellos): sincronización de la whitelist con los eventos on-chain, coordinación de los grupos de swap (pares
// incompletos, estado, allowances residuales) y avisos de operaciones de alto valor. Cada parte es idempotente; si una
// falla, las demás corren igual y el error queda en el log.
import type { Logger } from '../observability/logger.ts';

export interface EffectPart {
  name: string;
  runOnce: () => Promise<unknown>;
}

export class OperationEffects {
  readonly #parts: readonly EffectPart[];
  readonly #logger: Logger;

  constructor(parts: readonly EffectPart[], logger: Logger) {
    this.#parts = parts;
    this.#logger = logger;
  }

  async runOnce(): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    for (const part of this.#parts) {
      try {
        results[part.name] = await part.runOnce();
      } catch (error) {
        this.#logger.error({ err: error, effect: part.name }, 'falló una pasada de los efectos de operaciones');
        results[part.name] = { error: true };
      }
    }
    return results;
  }
}
