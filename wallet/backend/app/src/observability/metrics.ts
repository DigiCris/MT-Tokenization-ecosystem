// Métricas Prometheus [B-OBS] (prom-client). Un registry por proceso, servido en un puerto interno (nunca en los
// listeners públicos). Las métricas de cola, outbox y operaciones se calculan al momento del scrape.
import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<'listener' | 'method' | 'route' | 'status_code'>;
  authFailures: Counter<'reason'>;
  authRiskSignals: Counter<'signal'>;
  rateLimitHits: Counter<'listener' | 'policy'>;
  outboxDispatched: Counter<'queue'>;
  outboxDispatchErrors: Counter;
  outboxRequeued: Counter;
  rpcRequestDuration: Histogram<'provider' | 'method'>;
  rpcErrors: Counter<'provider' | 'kind'>;
  rpcHeadLag: Gauge<'provider'>;
  rpcHealthy: Gauge<'provider'>;
  rpcDisagreements: Counter<'method'>;
  auditChainVerified: Gauge;
  auditEventsWritten: Counter<'event_type'>;
  emailsSent: Counter<'template' | 'provider'>;
  emailSendErrors: Counter<'template' | 'provider' | 'retryable'>;
  emailsSkipped: Counter<'template' | 'reason'>;
}

export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry, prefix: 'mtw_' });
  const registers = [registry];
  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'mtw_http_request_duration_seconds',
      help: 'Duración de los requests HTTP por listener, ruta y status',
      labelNames: ['listener', 'method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    authFailures: new Counter({
      name: 'mtw_auth_failures_total',
      help: 'Fallos de autenticación por motivo',
      labelNames: ['reason'],
      registers,
    }),
    authRiskSignals: new Counter({
      name: 'mtw_auth_risk_signals_total',
      help: 'Señales de credential stuffing (pico de fallos, IP contra muchas cuentas) [B-AUTH-08]',
      labelNames: ['signal'],
      registers,
    }),
    rateLimitHits: new Counter({
      name: 'mtw_rate_limit_hits_total',
      help: 'Requests rechazados por rate limit',
      labelNames: ['listener', 'policy'],
      registers,
    }),
    outboxDispatched: new Counter({
      name: 'mtw_outbox_dispatched_total',
      help: 'Eventos del outbox publicados en la cola',
      labelNames: ['queue'],
      registers,
    }),
    outboxDispatchErrors: new Counter({
      name: 'mtw_outbox_dispatch_errors_total',
      help: 'Errores al publicar eventos del outbox',
      registers,
    }),
    outboxRequeued: new Counter({
      name: 'mtw_outbox_requeued_total',
      help: 'Eventos re-encolados desde Postgres tras perder el estado de Valkey',
      registers,
    }),
    rpcRequestDuration: new Histogram({
      name: 'mtw_rpc_request_duration_seconds',
      help: 'Latencia de las llamadas RPC por proveedor',
      labelNames: ['provider', 'method'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    rpcErrors: new Counter({
      name: 'mtw_rpc_errors_total',
      help: 'Errores RPC por proveedor y tipo',
      labelNames: ['provider', 'kind'],
      registers,
    }),
    rpcHeadLag: new Gauge({
      name: 'mtw_rpc_head_lag_blocks',
      help: 'Atraso del head de cada proveedor respecto del más adelantado',
      labelNames: ['provider'],
      registers,
    }),
    rpcHealthy: new Gauge({
      name: 'mtw_rpc_provider_healthy',
      help: '1 si el proveedor pasó el último health check',
      labelNames: ['provider'],
      registers,
    }),
    rpcDisagreements: new Counter({
      name: 'mtw_rpc_disagreements_total',
      help: 'Lecturas sensibles en las que los proveedores no coincidieron',
      labelNames: ['method'],
      registers,
    }),
    auditChainVerified: new Gauge({
      name: 'mtw_audit_chain_verified',
      help: '1 si la última verificación de la cadena de auditoría fue correcta, 0 si falló',
      registers,
    }),
    auditEventsWritten: new Counter({
      name: 'mtw_audit_events_written_total',
      help: 'Eventos de auditoría escritos',
      labelNames: ['event_type'],
      registers,
    }),
    emailsSent: new Counter({
      name: 'mtw_emails_sent_total',
      help: 'Emails entregados al proveedor por plantilla',
      labelNames: ['template', 'provider'],
      registers,
    }),
    emailSendErrors: new Counter({
      name: 'mtw_email_send_errors_total',
      help: 'Errores al enviar emails (los reintentables vuelven a la cola)',
      labelNames: ['template', 'provider', 'retryable'],
      registers,
    }),
    emailsSkipped: new Counter({
      name: 'mtw_emails_skipped_total',
      help: 'Emails no enviados a propósito (p. ej. el código ya venció cuando el job se ejecutó)',
      labelNames: ['template', 'reason'],
      registers,
    }),
  };
}

export interface ScrapeSources {
  /** Cantidad de jobs por cola y estado (waiting, active, delayed, failed). */
  queueCounts?: () => Promise<Record<string, Record<string, number>>>;
  /** Antigüedad en segundos del evento de outbox más viejo sin publicar (0 si no hay). */
  outboxLagSeconds?: () => Promise<number>;
  /** Operaciones por estado. */
  operationsByStatus?: () => Promise<Record<string, number>>;
}

/** Gauges calculados en cada scrape a partir de Postgres y de BullMQ. */
export function registerScrapeGauges(metrics: Metrics, sources: ScrapeSources): void {
  const registers = [metrics.registry];
  if (sources.queueCounts) {
    const read = sources.queueCounts;
    new Gauge({
      name: 'mtw_queue_jobs',
      help: 'Jobs por cola y estado',
      labelNames: ['queue', 'state'],
      registers,
      async collect() {
        this.reset();
        for (const [queue, counts] of Object.entries(await read())) {
          for (const [state, n] of Object.entries(counts)) this.set({ queue, state }, n);
        }
      },
    });
  }
  if (sources.outboxLagSeconds) {
    const read = sources.outboxLagSeconds;
    new Gauge({
      name: 'mtw_outbox_lag_seconds',
      help: 'Antigüedad del evento de outbox más viejo sin publicar',
      registers,
      async collect() {
        this.set(await read());
      },
    });
  }
  if (sources.operationsByStatus) {
    const read = sources.operationsByStatus;
    new Gauge({
      name: 'mtw_wallet_operations',
      help: 'Operaciones de wallet por estado',
      labelNames: ['status'],
      registers,
      async collect() {
        this.reset();
        for (const [status, n] of Object.entries(await read())) this.set({ status }, n);
      },
    });
  }
}

/** Servidor interno de métricas: sólo `GET /metrics`. */
export async function startMetricsServer(registry: Registry, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return server;
}
