// Tipos mínimos de Trusted Types (https://w3c.github.io/trusted-types/dist/spec/): lib.dom de TypeScript 6.0 no los
// incluye. Sólo lo que usa la app.
interface TrustedHTML {
  readonly brand: 'TrustedHTML';
}

interface TrustedScript {
  readonly brand: 'TrustedScript';
}

interface TrustedScriptURL {
  readonly brand: 'TrustedScriptURL';
  toString(): string;
}

interface TrustedTypePolicyOptions {
  createHTML?: (input: string, ...args: unknown[]) => string;
  createScript?: (input: string, ...args: unknown[]) => string;
  createScriptURL?: (input: string, ...args: unknown[]) => string;
}

interface TrustedTypePolicy {
  readonly name: string;
  createHTML(input: string, ...args: unknown[]): TrustedHTML;
  createScript(input: string, ...args: unknown[]): TrustedScript;
  createScriptURL(input: string, ...args: unknown[]): TrustedScriptURL;
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, options?: TrustedTypePolicyOptions): TrustedTypePolicy;
  getPolicyNames?: () => string[];
}

interface Window {
  readonly trustedTypes?: TrustedTypePolicyFactory;
}
