// P16.T04: la política mtw-default sólo acepta los workers de la allowlist del propio origin y nunca crea HTML ni
// scripts; se crea una sola vez.
import { afterEach, describe, expect, it } from 'vitest';
import { installTrustedTypes, POLICY_NAME, resetTrustedTypesForTests, trustedScriptURL } from './trusted-types.ts';

const BASE = 'https://recovery.example/device-check';

/** Fábrica que registra la política creada y devuelve objetos con la forma de TrustedScriptURL. */
function factory() {
  const created: { name: string; options: TrustedTypePolicyOptions }[] = [];
  const value: TrustedTypePolicyFactory = {
    createPolicy(name, options = {}) {
      if (created.some((p) => p.name === name)) throw new TypeError('política duplicada');
      created.push({ name, options });
      const call = (fn: ((input: string) => string) | undefined, input: string) => {
        if (fn === undefined) throw new TypeError('sin función');
        return fn(input);
      };
      return {
        name,
        createHTML: (input) =>
          ({ brand: 'TrustedHTML', value: call(options.createHTML, input) }) as unknown as TrustedHTML,
        createScript: (input) =>
          ({ brand: 'TrustedScript', value: call(options.createScript, input) }) as unknown as TrustedScript,
        createScriptURL: (input) => {
          const url = call(options.createScriptURL, input);
          return { brand: 'TrustedScriptURL', toString: () => url };
        },
      };
    },
  };
  return { value, created };
}

afterEach(() => {
  resetTrustedTypesForTests();
});

describe('política mtw-default', () => {
  it('acepta sólo URLs de la allowlist del propio origin (relativas o absolutas)', () => {
    const { value, created } = factory();
    installTrustedTypes(['/assets/argon2.worker-abc.js'], value, BASE);
    expect(created.map((p) => p.name)).toEqual([POLICY_NAME]);
    expect(String(trustedScriptURL('/assets/argon2.worker-abc.js'))).toBe(
      'https://recovery.example/assets/argon2.worker-abc.js',
    );
    expect(String(trustedScriptURL('https://recovery.example/assets/argon2.worker-abc.js'))).toBe(
      'https://recovery.example/assets/argon2.worker-abc.js',
    );
    expect(() => trustedScriptURL('/assets/otro.js')).toThrow(TypeError);
    expect(() => trustedScriptURL('https://evil.example/assets/argon2.worker-abc.js')).toThrow(TypeError);
    expect(() => trustedScriptURL('data:text/javascript,alert(1)')).toThrow(TypeError);
  });

  it('nunca crea HTML ni scripts', () => {
    const { value } = factory();
    const policy = installTrustedTypes([], value, BASE);
    expect(() => policy.createHTML('<b>x</b>')).toThrow(TypeError);
    expect(() => policy.createScript('alert(1)')).toThrow(TypeError);
  });

  it('una sola vez; sin Trusted Types o sin política instalada, falla', () => {
    const { value } = factory();
    expect(() => trustedScriptURL('/assets/argon2.worker-abc.js')).toThrow(/no está instalada/);
    expect(() => installTrustedTypes([], undefined, BASE)).toThrow(/no soporta/);
    installTrustedTypes([], value, BASE);
    expect(() => installTrustedTypes([], value, BASE)).toThrow(/ya fue creada/);
  });
});
