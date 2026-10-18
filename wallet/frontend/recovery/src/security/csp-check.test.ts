// P16.T04: la comprobación de arranque detecta cada forma en que la CSP o Trusted Types pueden no aplicarse.
import { describe, expect, it } from 'vitest';
import { checkCsp, CSP_PROBE_POLICY, type CspProbes } from './csp-check.ts';

const blocked = () => {
  throw new TypeError('bloqueado');
};

function probes(overrides: Partial<CspProbes> = {}): CspProbes {
  return {
    trustedTypes: { createPolicy: blocked },
    assignScriptSink: blocked,
    ...overrides,
  };
}

describe('comprobación de la CSP al arrancar', () => {
  it('todo bloqueado: la CSP se aplica', () => {
    expect(checkCsp(probes())).toBeNull();
  });

  it('sin Trusted Types → TRUSTED_TYPES_UNSUPPORTED', () => {
    expect(checkCsp(probes({ trustedTypes: undefined }))).toBe('TRUSTED_TYPES_UNSUPPORTED');
  });

  it('se puede crear una política con otro nombre → TRUSTED_TYPES_NOT_ENFORCED', () => {
    const created: string[] = [];
    const factory: TrustedTypePolicyFactory = {
      createPolicy: (name) => {
        created.push(name);
        return { name } as TrustedTypePolicy;
      },
    };
    expect(checkCsp(probes({ trustedTypes: factory }))).toBe('TRUSTED_TYPES_NOT_ENFORCED');
    expect(created).toEqual([CSP_PROBE_POLICY]);
  });

  it('un string llega a un sink de script → TRUSTED_TYPES_NOT_ENFORCED', () => {
    expect(checkCsp(probes({ assignScriptSink: () => undefined }))).toBe('TRUSTED_TYPES_NOT_ENFORCED');
  });
});
