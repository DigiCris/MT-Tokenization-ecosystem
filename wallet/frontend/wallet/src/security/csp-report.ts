// Reporte de violaciones de CSP/Trusted Types y de eventos de seguridad del arranque ([F-SEC-02], [F-SEC-04],
// P16.T04): escucha `securitypolicyviolation` y envía cada violación distinta, una sola vez por carga y con un tope, a
// `POST /api/v1/security/csp-report` del API host de la app, sin cookies (`credentials: 'omit'`) y sin datos sensibles:
// rutas sin query ni fragmento, el recurso bloqueado reducido a palabra clave u origin + ruta y, de la muestra, sólo el
// sink o el nombre de la política. Descuenta exactamente las violaciones que generan las pruebas de arranque.
import type { CspCheckFailure } from './csp-check.ts';

export type SecurityReport =
  | {
      type: 'CSP_VIOLATION';
      releaseId: string;
      documentPath: string;
      directive: string;
      disposition: 'enforce' | 'report';
      blocked: string;
      sourcePath: string | null;
      line: number | null;
      column: number | null;
      sample: string | null;
    }
  | { type: 'SERVICE_WORKER_REMOVED'; releaseId: string; documentPath: string; scope: string }
  | { type: 'CSP_INACTIVE'; releaseId: string; documentPath: string; check: CspCheckFailure };

export type CspViolationReport = Extract<SecurityReport, { type: 'CSP_VIOLATION' }>;

/** Lo que la app lee del evento (subconjunto de SecurityPolicyViolationEvent). */
export interface ViolationLike {
  effectiveDirective: string;
  blockedURI: string;
  documentURI: string;
  sourceFile: string;
  lineNumber: number;
  columnNumber: number;
  sample: string;
  disposition: string;
}

const KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'data', 'blob', 'trusted-types-sink', 'trusted-types-policy']);
const MAX_REPORTS = 20;

function pathOf(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function blockedOf(uri: string): string | null {
  if (KEYWORDS.has(uri)) return uri;
  try {
    const url = new URL(uri);
    if (url.protocol === 'data:') return 'data';
    if (url.protocol === 'blob:') return 'blob';
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${url.pathname}`;
  } catch {
    // Valor que el navegador no expresa como URL: no se reporta.
  }
  return null;
}

/** Sólo el sink ("Element innerHTML") o el nombre de la política: nunca el valor asignado. */
function sampleOf(blocked: string, sample: string): string | null {
  if (blocked !== 'trusted-types-sink' && blocked !== 'trusted-types-policy') return null;
  const head = blocked === 'trusted-types-sink' ? (sample.split('|')[0] ?? '') : sample;
  return /^[A-Za-z][\w .-]{0,63}$/.test(head) ? head : null;
}

export function violationKey(event: Pick<ViolationLike, 'effectiveDirective' | 'blockedURI' | 'sample'>): string {
  const blocked = blockedOf(event.blockedURI) ?? '';
  return `${event.effectiveDirective}|${blocked}|${sampleOf(blocked, event.sample) ?? ''}`;
}

export function reportOf(event: ViolationLike, releaseId: string, origin: string): CspViolationReport | null {
  const blocked = blockedOf(event.blockedURI);
  const documentPath = pathOf(event.documentURI, origin);
  if (blocked === null || documentPath === null || !/^[a-z-]{1,64}$/.test(event.effectiveDirective)) return null;
  const position = (n: number) => (Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000 ? n : null);
  return {
    type: 'CSP_VIOLATION',
    releaseId,
    documentPath,
    directive: event.effectiveDirective,
    disposition: event.disposition === 'report' ? 'report' : 'enforce',
    blocked,
    sourcePath: event.sourceFile ? pathOf(event.sourceFile, origin) : null,
    line: position(event.lineNumber),
    column: position(event.columnNumber),
    sample: sampleOf(blocked, event.sample),
  };
}

export type Send = (url: string, body: string) => void;

export const sendWithFetch: Send = (url, body) => {
  void fetch(url, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    keepalive: true,
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => undefined);
};

export interface CspReporter {
  /** Descuenta una violación esperada (prueba de arranque) por su clave. */
  expect: (key: string) => void;
  serviceWorkerRemoved: (scope: string) => void;
  cspInactive: (check: CspCheckFailure) => void;
  /** Reportes enviados en esta carga (para la página de comprobación del dispositivo). */
  sent: () => number;
  dispose: () => void;
}

export function installCspReporter(options: {
  endpoint: string;
  releaseId: string;
  target?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  location?: Pick<Location, 'origin' | 'pathname'>;
  send?: Send;
}): CspReporter {
  const target = options.target ?? document;
  const location = options.location ?? window.location;
  const send = options.send ?? sendWithFetch;
  const expected = new Map<string, number>();
  const seen = new Set<string>();
  let count = 0;
  const post = (report: SecurityReport, dedupe: string) => {
    if (seen.has(dedupe) || count >= MAX_REPORTS) return;
    seen.add(dedupe);
    count += 1;
    send(options.endpoint, JSON.stringify(report));
  };
  const onViolation = (event: Event) => {
    const violation = event as unknown as ViolationLike;
    const key = violationKey(violation);
    const pending = expected.get(key) ?? 0;
    if (pending > 0) {
      expected.set(key, pending - 1);
      return;
    }
    const report = reportOf(violation, options.releaseId, location.origin);
    if (report === null) return;
    post(report, JSON.stringify(report));
  };
  target.addEventListener('securitypolicyviolation', onViolation);
  return {
    expect: (key) => expected.set(key, (expected.get(key) ?? 0) + 1),
    serviceWorkerRemoved: (scope) => {
      const path = pathOf(scope, location.origin) ?? '/';
      post(
        { type: 'SERVICE_WORKER_REMOVED', releaseId: options.releaseId, documentPath: location.pathname, scope: path },
        `sw|${path}`,
      );
    },
    cspInactive: (check) => {
      post(
        { type: 'CSP_INACTIVE', releaseId: options.releaseId, documentPath: location.pathname, check },
        `csp|${check}`,
      );
    },
    sent: () => count,
    dispose: () => {
      target.removeEventListener('securitypolicyviolation', onViolation);
    },
  };
}
