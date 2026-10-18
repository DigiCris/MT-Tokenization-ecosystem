// P16.T04: POST /api/v1/security/csp-report en los dos listeners, contra Fastify y Valkey reales. Público y sin CSRF
// (la app lo envía sin cookies, también antes del login); acepta los tres tipos de reporte, rechaza con 400 los campos con
// datos sensibles (query, fragmento, muestras arbitrarias) o desconocidos, deja un log estructurado y una métrica, y
// tiene un bucket de rate limit propio por IP.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/logger.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const URL = '/api/v1/security/csp-report';
const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    callback();
  },
});

let db: TestDatabase;
const listeners: Partial<Record<'WALLET' | 'RECOVERY', TestListener>> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  for (const client of ['WALLET', 'RECOVERY'] as const) {
    listeners[client] = await buildTestListener({
      db,
      client,
      logger: createLogger({ level: 'info', service: 'test', destination: sink }),
    });
  }
});

afterAll(async () => {
  await Promise.all(Object.values(listeners).map((l) => l.close()));
  await db.close();
});

const violation = {
  type: 'CSP_VIOLATION',
  releaseId: 'wallet-local-0123456789ab',
  documentPath: '/send',
  directive: 'require-trusted-types-for',
  disposition: 'enforce',
  blocked: 'trusted-types-sink',
  sourcePath: '/assets/index-3f2a1b.js',
  line: 12,
  column: 3401,
  sample: 'Element innerHTML',
};

/** IP propia por llamada (TEST-NET-2): el bucket por IP no se comparte entre tests; Valkey es nuevo en cada corrida. */
let nextHost = 1;
function ip(): string {
  return `198.51.100.${String(nextHost++)}`;
}

async function report(client: 'WALLET' | 'RECOVERY', body: unknown, remoteAddress = ip(), headers = {}) {
  const listener = listeners[client];
  if (!listener) throw new Error('listener no inicializado');
  return listener.app.inject({
    method: 'POST',
    url: URL,
    headers: { origin: listener.origin, 'content-type': 'application/json', ...headers },
    remoteAddress,
    payload: JSON.stringify(body),
  });
}

describe('reporte de seguridad de los frontends', () => {
  it.each(['WALLET', 'RECOVERY'] as const)(
    '%s: sin cookies ni CSRF → 204, log estructurado y métrica',
    async (client) => {
      const before = lines.length;
      const response = await report(client, violation);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      const logged = lines
        .slice(before)
        .map((l) => JSON.parse(l) as { event?: string; client?: string; report?: unknown })
        .find((l) => l.event === 'frontend_security_report');
      expect(logged).toMatchObject({ client, report: violation });
      const metric = await listeners[client]?.metrics.registry.getSingleMetricAsString(
        'mtw_frontend_security_reports_total',
      );
      expect(metric).toContain(`client="${client}",type="CSP_VIOLATION",directive="require-trusted-types-for"`);
    },
  );

  it('acepta el service worker desregistrado y la CSP inactiva', async () => {
    const sw = await report('WALLET', {
      type: 'SERVICE_WORKER_REMOVED',
      releaseId: 'wallet-local-0123456789ab',
      documentPath: '/',
      scope: '/',
    });
    expect(sw.statusCode).toBe(204);
    const inactive = await report('RECOVERY', {
      type: 'CSP_INACTIVE',
      releaseId: 'recovery-local-0123456789ab',
      documentPath: '/login',
      check: 'TRUSTED_TYPES_UNSUPPORTED',
    });
    expect(inactive.statusCode).toBe(204);
    const metric = await listeners.RECOVERY?.metrics.registry.getSingleMetricAsString(
      'mtw_frontend_security_reports_total',
    );
    expect(metric).toContain('client="RECOVERY",type="CSP_INACTIVE",directive="TRUSTED_TYPES_UNSUPPORTED"');
  });

  it.each([
    ['query en la ruta del documento', { documentPath: '/reset-password?token=abc' }],
    ['fragmento en la ruta del documento', { documentPath: '/enroll#eid=1&n=2' }],
    ['query en el recurso bloqueado', { blocked: 'https://evil.example/x?leak=1' }],
    ['muestra arbitraria (contenido del sink)', { sample: 'Element innerHTML|<img src=x onerror=alert(1)>' }],
    ['directiva inválida', { directive: 'script-src <x>' }],
    ['campo desconocido', { extra: 'x' }],
    ['tipo desconocido', { type: 'OTHER' }],
  ])('rechaza %s (400)', async (_label, patch) => {
    const response = await report('WALLET', { ...violation, ...patch });
    expect(response.statusCode).toBe(400);
  });

  it('sólo JSON (415)', async () => {
    const response = await report('WALLET', violation, ip(), { 'content-type': 'application/csp-report' });
    expect(response.statusCode).toBe(415);
  });

  it('bucket propio por IP: 30 por minuto y luego 429 con Retry-After; otra IP sigue', async () => {
    const address = ip();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await report('WALLET', violation, address)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 204)).toBe(true);
    const limited = await report('RECOVERY', violation, address);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(codes[30]).toBe(429);
    expect((await report('WALLET', violation, ip())).statusCode).toBe(204);
  });
});
