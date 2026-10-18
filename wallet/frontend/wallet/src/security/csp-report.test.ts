// P16.T04: el reporter manda cada violación distinta una sola vez, sin datos sensibles, descuenta exactamente las
// violaciones de las pruebas de arranque y respeta el tope por carga.
import { describe, expect, it } from 'vitest';
import { EXPECTED_PROBE_VIOLATIONS } from './csp-check.ts';
import { installCspReporter, reportOf, violationKey, type ViolationLike } from './csp-report.ts';

const ORIGIN = 'https://wallet.example';

function violation(overrides: Partial<ViolationLike> = {}): ViolationLike {
  return {
    effectiveDirective: 'require-trusted-types-for',
    blockedURI: 'trusted-types-sink',
    documentURI: `${ORIGIN}/send?to=0xabc#frag`,
    sourceFile: `${ORIGIN}/assets/index-abc.js?v=1`,
    lineNumber: 1,
    columnNumber: 2048,
    sample: 'Element innerHTML|<img src=x onerror=alert(1)>secreto',
    disposition: 'enforce',
    ...overrides,
  };
}

class FakeTarget {
  readonly listeners = new Set<(event: Event) => void>();
  addEventListener(_type: string, listener: (event: Event) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: Event) => void) {
    this.listeners.delete(listener);
  }
  dispatch(v: ViolationLike) {
    for (const listener of this.listeners) listener(v as unknown as Event);
  }
}

function setup() {
  const target = new FakeTarget();
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const reporter = installCspReporter({
    endpoint: 'http://localhost:8080/api/v1/security/csp-report',
    releaseId: 'wallet-local-0123456789ab',
    target: target,
    location: { origin: ORIGIN, pathname: '/send' },
    send: (url, body) => sent.push({ url, body: JSON.parse(body) as Record<string, unknown> }),
  });
  return { target, sent, reporter };
}

describe('reporte de una violación', () => {
  it('sólo rutas sin query ni fragmento, el sink sin el valor y la posición', () => {
    expect(reportOf(violation(), 'wallet-local-0123456789ab', ORIGIN)).toEqual({
      type: 'CSP_VIOLATION',
      releaseId: 'wallet-local-0123456789ab',
      documentPath: '/send',
      directive: 'require-trusted-types-for',
      disposition: 'enforce',
      blocked: 'trusted-types-sink',
      sourcePath: '/assets/index-abc.js',
      line: 1,
      column: 2048,
      sample: 'Element innerHTML',
    });
  });

  it('recursos externos: origin + ruta; data: y blob: como palabra clave; script ajeno sin ruta', () => {
    const external = reportOf(
      violation({
        effectiveDirective: 'connect-src',
        blockedURI: 'https://evil.example/collect?leak=secreto#x',
        sample: '',
        sourceFile: 'https://cdn.example/x.js',
      }),
      'r',
      ORIGIN,
    );
    expect(external).toMatchObject({ blocked: 'https://evil.example/collect', sourcePath: null, sample: null });
    expect(
      reportOf(violation({ blockedURI: 'data:text/html,secreto', effectiveDirective: 'img-src' }), 'r', ORIGIN),
    ).toMatchObject({
      blocked: 'data',
      sample: null,
    });
    expect(reportOf(violation({ blockedURI: 'blob:https://wallet.example/123' }), 'r', ORIGIN)?.blocked).toBe('blob');
  });

  it('política de Trusted Types: sólo el nombre; muestras con otra forma se descartan', () => {
    expect(
      reportOf(
        violation({ effectiveDirective: 'trusted-types', blockedURI: 'trusted-types-policy', sample: 'evil-policy' }),
        'r',
        ORIGIN,
      )?.sample,
    ).toBe('evil-policy');
    expect(reportOf(violation({ sample: '<script>|x' }), 'r', ORIGIN)?.sample).toBeNull();
  });

  it('sin reporte si el documento es de otro origin, la directiva es rara o el recurso no se puede expresar', () => {
    expect(reportOf(violation({ documentURI: 'https://otro.example/' }), 'r', ORIGIN)).toBeNull();
    expect(reportOf(violation({ effectiveDirective: 'Script-Src <x>' }), 'r', ORIGIN)).toBeNull();
    expect(reportOf(violation({ blockedURI: 'chrome-extension' }), 'r', ORIGIN)).toBeNull();
  });

  it('posiciones fuera de rango se informan como null', () => {
    expect(reportOf(violation({ lineNumber: -1, columnNumber: 1.5 }), 'r', ORIGIN)).toMatchObject({
      line: null,
      column: null,
    });
  });
});

describe('reporter', () => {
  it('descuenta exactamente las violaciones de las pruebas de arranque y reporta las demás', () => {
    const { target, sent, reporter } = setup();
    for (const key of EXPECTED_PROBE_VIOLATIONS) reporter.expect(key);
    target.dispatch(
      violation({ effectiveDirective: 'trusted-types', blockedURI: 'trusted-types-policy', sample: 'mtw-csp-probe' }),
    );
    target.dispatch(violation({ sample: 'HTMLScriptElement text|' }));
    expect(sent).toHaveLength(0);
    // Un segundo sink de script ya no es una prueba: se reporta.
    target.dispatch(violation({ sample: 'HTMLScriptElement text|' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://localhost:8080/api/v1/security/csp-report');
    expect(sent[0]?.body).toMatchObject({ directive: 'require-trusted-types-for', sample: 'HTMLScriptElement text' });
    expect(reporter.sent()).toBe(1);
  });

  it('cada violación distinta una sola vez, con un tope de 20 por carga', () => {
    const { target, sent } = setup();
    target.dispatch(violation());
    target.dispatch(violation());
    expect(sent).toHaveLength(1);
    for (let line = 2; line < 40; line++) target.dispatch(violation({ lineNumber: line }));
    expect(sent).toHaveLength(20);
    expect(JSON.stringify(sent)).not.toContain('secreto');
  });

  it('service worker desregistrado y CSP inactiva, deduplicados', () => {
    const { sent, reporter } = setup();
    reporter.serviceWorkerRemoved(`${ORIGIN}/app/`);
    reporter.serviceWorkerRemoved(`${ORIGIN}/app/`);
    reporter.cspInactive('TRUSTED_TYPES_UNSUPPORTED');
    expect(sent.map((s) => s.body)).toEqual([
      { type: 'SERVICE_WORKER_REMOVED', releaseId: 'wallet-local-0123456789ab', documentPath: '/send', scope: '/app/' },
      {
        type: 'CSP_INACTIVE',
        releaseId: 'wallet-local-0123456789ab',
        documentPath: '/send',
        check: 'TRUSTED_TYPES_UNSUPPORTED',
      },
    ]);
  });

  it('dispose deja de escuchar', () => {
    const { target, sent, reporter } = setup();
    reporter.dispose();
    target.dispatch(violation());
    expect(sent).toHaveLength(0);
  });

  it('las claves de las pruebas coinciden con las de los eventos reales', () => {
    expect(
      violationKey({
        effectiveDirective: 'trusted-types',
        blockedURI: 'trusted-types-policy',
        sample: 'mtw-csp-probe',
      }),
    ).toBe(EXPECTED_PROBE_VIOLATIONS[0]);
    expect(
      violationKey({
        effectiveDirective: 'require-trusted-types-for',
        blockedURI: 'trusted-types-sink',
        sample: 'HTMLScriptElement text|',
      }),
    ).toBe(EXPECTED_PROBE_VIOLATIONS[1]);
  });
});
