// [B-OBS] Métricas Prometheus: servidor interno (sólo GET /metrics), métricas HTTP por listener y ruta, y gauges
// calculados en el scrape (cola, lag del outbox, operaciones por estado).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetrics, registerScrapeGauges, startMetricsServer } from '../../src/observability/metrics.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { freePort } from '../helpers/fork.ts';

let db: TestDatabase;
let listener: TestListener;

beforeAll(async () => {
  db = await createTestDatabase();
  listener = await buildTestListener({ db, metrics: createMetrics({ defaultMetrics: false }) });
});
afterAll(async () => {
  await listener.close();
  await db.close();
});

describe('métricas', () => {
  it('el servidor interno expone sólo GET /metrics', async () => {
    const metrics = createMetrics();
    const port = await freePort();
    const server = await startMetricsServer(metrics.registry, '127.0.0.1', port);
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      const body = await ok.text();
      expect(body).toContain('mtw_process_cpu_user_seconds_total');
      expect(body).toContain('mtw_http_request_duration_seconds');
      expect((await fetch(`http://127.0.0.1:${port}/otra`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  });

  it('cada request suma a la duración HTTP con listener, ruta y status', async () => {
    await listener.app.inject({ method: 'GET', url: '/api/v1/health' });
    await listener.app.inject({ method: 'GET', url: '/api/v1/no-existe' });
    const text = await listener.metrics.registry.getSingleMetricAsString('mtw_http_request_duration_seconds');
    expect(text).toContain('listener="WALLET",method="GET",route="/api/v1/health",status_code="200"');
    expect(text).toContain('route="unmatched",status_code="404"');
  });

  it('los gauges de cola, outbox y operaciones se calculan en el scrape', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    let lag = 3.5;
    registerScrapeGauges(metrics, {
      queueCounts: () => Promise.resolve({ 'wallet-operations': { waiting: 2, active: 1, delayed: 0, failed: 4 } }),
      outboxLagSeconds: () => Promise.resolve(lag),
      operationsByStatus: () => Promise.resolve({ QUEUED: 5, FINALIZED: 9 }),
    });
    const first = await metrics.registry.metrics();
    expect(first).toContain('mtw_queue_jobs{queue="wallet-operations",state="failed"} 4');
    expect(first).toContain('mtw_outbox_lag_seconds 3.5');
    expect(first).toContain('mtw_wallet_operations{status="FINALIZED"} 9');
    lag = 0;
    expect(await metrics.registry.metrics()).toContain('mtw_outbox_lag_seconds 0');
  });
});
