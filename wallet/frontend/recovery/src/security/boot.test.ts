// P16.T04: el arranque reporta la CSP inactiva y no instala nada; con la CSP activa instala la política y desregistra
// service workers; si otro script tomó la política, la app no opera.
import { afterEach, describe, expect, it } from 'vitest';
import { bootSecurity, type BootOptions } from './boot.ts';
import type { CspProbes } from './csp-check.ts';
import { resetTrustedTypesForTests, trustedScriptURL } from './trusted-types.ts';

const blocked = () => {
  throw new TypeError('bloqueado');
};

const location = { origin: 'https://recovery.example', pathname: '/', href: 'https://recovery.example/' };
const target = { addEventListener: () => undefined, removeEventListener: () => undefined };

function options(probes: CspProbes, sent: string[], registrations: string[] = []): BootOptions {
  return {
    apiBaseUrl: 'http://localhost:8080/api/v1',
    releaseId: 'recovery-local-0123456789ab',
    workerAllowlist: ['/assets/argon2.worker-abc.js'],
    probes,
    send: (_url, body) => sent.push(body),
    target,
    location,
    serviceWorkers: {
      getRegistrations: () =>
        Promise.resolve(
          registrations.map(
            (scope) => ({ scope, unregister: () => Promise.resolve(true) }) as unknown as ServiceWorkerRegistration,
          ),
        ),
    },
  };
}

function enforcingFactory(): TrustedTypePolicyFactory {
  return {
    createPolicy(name, policyOptions = {}) {
      if (name !== 'mtw-default') throw new TypeError('nombre no permitido');
      return {
        name,
        createHTML: blocked,
        createScript: blocked,
        createScriptURL: (input) => {
          const url = policyOptions.createScriptURL?.(input) ?? '';
          return { brand: 'TrustedScriptURL', toString: () => url };
        },
      };
    },
  };
}

afterEach(() => {
  resetTrustedTypesForTests();
});

describe('arranque de seguridad', () => {
  it('CSP inactiva: falla, lo reporta y no instala la política', async () => {
    const sent: string[] = [];
    const result = await bootSecurity(
      options({ trustedTypes: enforcingFactory(), assignScriptSink: () => undefined }, sent),
    );
    expect(result.failure).toBe('TRUSTED_TYPES_NOT_ENFORCED');
    expect(sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      {
        type: 'CSP_INACTIVE',
        releaseId: 'recovery-local-0123456789ab',
        documentPath: '/',
        check: 'TRUSTED_TYPES_NOT_ENFORCED',
      },
    ]);
    expect(() => trustedScriptURL('/assets/argon2.worker-abc.js')).toThrow(/no está instalada/);
  });

  it('CSP activa: instala mtw-default con la allowlist y desregistra service workers', async () => {
    const sent: string[] = [];
    const result = await bootSecurity(
      options({ trustedTypes: enforcingFactory(), assignScriptSink: blocked }, sent, ['https://recovery.example/']),
    );
    expect(result.failure).toBeNull();
    expect(result.removedServiceWorkers).toBe(1);
    expect(String(trustedScriptURL('/assets/argon2.worker-abc.js'))).toBe(
      'https://recovery.example/assets/argon2.worker-abc.js',
    );
    expect(sent.map((s) => JSON.parse(s) as { type: string })).toEqual([
      { type: 'SERVICE_WORKER_REMOVED', releaseId: 'recovery-local-0123456789ab', documentPath: '/', scope: '/' },
    ]);
  });

  it('la política ya existe (otro script la creó antes): TRUSTED_TYPES_POLICY_TAKEN', async () => {
    const taken: TrustedTypePolicyFactory = { createPolicy: blocked };
    const result = await bootSecurity(options({ trustedTypes: taken, assignScriptSink: blocked }, []));
    expect(result.failure).toBe('TRUSTED_TYPES_POLICY_TAKEN');
  });
});
