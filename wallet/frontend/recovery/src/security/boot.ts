// Arranque de seguridad de la app Recovery (P16.T04), antes de renderizar: reporter de violaciones, comprobación de que
// la CSP y Trusted Types se aplican (si no, la app no opera), política mtw-default con la allowlist de workers y
// kill-switch de service workers. Las dependencias del navegador se pueden inyectar (tests).
import {
  browserProbes,
  checkCsp,
  EXPECTED_PROBE_VIOLATIONS,
  type CspCheckFailure,
  type CspProbes,
} from './csp-check.ts';
import { installCspReporter, type CspReporter, type Send } from './csp-report.ts';
import { removeServiceWorkers } from './sw-killswitch.ts';
import { installTrustedTypes } from './trusted-types.ts';

export type BootFailure = CspCheckFailure | 'TRUSTED_TYPES_POLICY_TAKEN';

export interface BootResult {
  failure: BootFailure | null;
  reporter: CspReporter;
  removedServiceWorkers: number;
}

export interface BootOptions {
  apiBaseUrl: string;
  releaseId: string;
  workerAllowlist: readonly string[];
  probes?: CspProbes;
  send?: Send;
  target?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  location?: Pick<Location, 'origin' | 'pathname' | 'href'>;
  serviceWorkers?: Pick<ServiceWorkerContainer, 'getRegistrations'>;
}

export async function bootSecurity(options: BootOptions): Promise<BootResult> {
  const location = options.location ?? window.location;
  const reporter = installCspReporter({
    endpoint: `${options.apiBaseUrl}/security/csp-report`,
    releaseId: options.releaseId,
    location,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.send === undefined ? {} : { send: options.send }),
  });
  for (const key of EXPECTED_PROBE_VIOLATIONS) reporter.expect(key);
  const probes = options.probes ?? browserProbes();
  const inactive = checkCsp(probes);
  if (inactive !== null) {
    reporter.cspInactive(inactive);
    return { failure: inactive, reporter, removedServiceWorkers: 0 };
  }
  try {
    installTrustedTypes(options.workerAllowlist, probes.trustedTypes, location.href);
  } catch {
    // Otro script creó la política antes que la app: el navegador ya reportó la violación de `trusted-types`.
    return { failure: 'TRUSTED_TYPES_POLICY_TAKEN', reporter, removedServiceWorkers: 0 };
  }
  const serviceWorkers = options.serviceWorkers ?? navigator.serviceWorker;
  const removedServiceWorkers = await removeServiceWorkers(serviceWorkers, (scope) => {
    reporter.serviceWorkerRemoved(scope);
  });
  return { failure: null, reporter, removedServiceWorkers };
}
