// Política única de Trusted Types `mtw-default` ([F-SEC-02], P16.T04). La CSP exige Trusted Types para todo sink de
// script (`require-trusted-types-for 'script'`) y sólo permite crear esta política (`trusted-types mtw-default`):
// `createScriptURL` devuelve únicamente URLs del propio origin que estén en la allowlist de workers resuelta en el build
// (assets con hash, src/workers/registry.ts), y `createHTML`/`createScript` siempre fallan. Cualquier otra asignación de
// un string a un sink queda bloqueada por el navegador y la reporta src/security/csp-report.ts.
export const POLICY_NAME = 'mtw-default';

let policy: TrustedTypePolicy | null = null;

/**
 * Crea la política (una sola vez por documento) con la fábrica del documento (`window.trustedTypes`) y su URL. Falla si
 * ya existe: otro script la habría tomado antes.
 */
export function installTrustedTypes(
  workerUrls: readonly string[],
  factory: TrustedTypePolicyFactory | undefined,
  base: string,
): TrustedTypePolicy {
  if (policy !== null) throw new Error(`la política ${POLICY_NAME} ya fue creada`);
  if (factory === undefined) throw new Error('el navegador no soporta Trusted Types');
  const origin = new URL(base).origin;
  const allowlist = new Set(workerUrls.map((url) => new URL(url, base).href));
  policy = factory.createPolicy(POLICY_NAME, {
    createScriptURL(input) {
      const url = new URL(input, base);
      if (url.origin !== origin || !allowlist.has(url.href)) {
        throw new TypeError(`${POLICY_NAME}: URL de script fuera de la allowlist (${url.pathname})`);
      }
      return url.href;
    },
    createHTML() {
      throw new TypeError(`${POLICY_NAME} no crea HTML`);
    },
    createScript() {
      throw new TypeError(`${POLICY_NAME} no crea scripts`);
    },
  });
  return policy;
}

/** URL de un worker de la allowlist como TrustedScriptURL (lanza si no está permitida o falta la política). */
export function trustedScriptURL(url: string): TrustedScriptURL {
  if (policy === null) throw new Error(`la política ${POLICY_NAME} no está instalada`);
  return policy.createScriptURL(url);
}

/**
 * Único lugar donde la app construye un Worker: con la TrustedScriptURL de la allowlist (con Trusted Types forzado,
 * `new Worker(string)` está bloqueado).
 */
export function createTrustedWorker(url: string, options: WorkerOptions): Worker {
  // El constructor tipado de TypeScript no conoce TrustedScriptURL; el navegador la acepta tal cual.
  return new Worker(trustedScriptURL(url) as unknown as string, options);
}

/** Sólo para tests: olvida la política del módulo (el navegador nunca permite recrearla). */
export function resetTrustedTypesForTests(): void {
  policy = null;
}
