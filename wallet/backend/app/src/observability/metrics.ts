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
  signerRequests: Counter<'shard' | 'route' | 'result'>;
  gasTankBalanceWei: Gauge;
  executorsBelowMinimum: Gauge;
  gasTankTransactions: Counter<'purpose' | 'result'>;
  walletOnboarding: Counter<'step' | 'result'>;
  recoveryEnrollmentRejections: Counter<'reason' | 'purpose' | 'alerted'>;
  walletVerificationFailures: Counter<'item'>;
  operationTransitions: Counter<'to'>;
  operationErrors: Counter<'code'>;
  workerStepDuration: Histogram<'step'>;
  executorTransactions: Counter<'result'>;
  reorgsDetected: Counter<'kind'>;
  rotationEventApplyFailures: Counter<'kind'>;
  rotationEventsQuarantined: Gauge;
  sovereignModified: Counter;
  reconcilerDiscrepancies: Counter<'kind'>;
  indexerHeadBlock: Gauge<'indexer'>;
  whitelistEvents: Counter<'event'>;
  twoFactorChallenges: Counter<'method' | 'result'>;
  swapQuotes: Counter<'result'>;
  notificationsCreated: Counter<'type'>;
  frontendSecurityReports: Counter<'client' | 'type' | 'directive'>;
  integrityStatus: Gauge<'app'>;
  cooperationState: Gauge;
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
    signerRequests: new Counter({
      name: 'mtw_signer_requests_total',
      help: 'Pedidos al signer por shard, ruta y resultado (ok o código de error del signer)',
      labelNames: ['shard', 'route', 'result'],
      registers,
    }),
    gasTankBalanceWei: new Gauge({
      name: 'mtw_gas_tank_balance_wei',
      help: 'Saldo de ETH de la cuenta gas tank [B-SIG-05]',
      registers,
    }),
    executorsBelowMinimum: new Gauge({
      name: 'mtw_gas_executors_below_minimum',
      help: 'Claves S con saldo de ETH por debajo de GAS_TOPUP_MIN_WEI en la última pasada del gas tank',
      registers,
    }),
    gasTankTransactions: new Counter({
      name: 'mtw_gas_tank_transactions_total',
      help: 'Transacciones de la cuenta gas tank por propósito (TOPUP, DEPLOY, CANCEL_RELAY) y resultado',
      labelNames: ['purpose', 'result'],
      registers,
    }),
    walletOnboarding: new Counter({
      name: 'mtw_wallet_onboarding_total',
      help: 'Pasos del onboarding de wallets (create, user_key, enrollment, executor, authorization, deploy, verify) por resultado',
      labelNames: ['step', 'result'],
      registers,
    }),
    recoveryEnrollmentRejections: new Counter({
      name: 'mtw_recovery_enrollment_rejections_total',
      help: 'Enrollments de R que la Wallet rechazó porque no pudo confirmar la R ([F-LNK-02]): posible sustitución de R (alerta con alerted="true"; "false" es el aviso tardío de un pedido reemplazado hace más que su vigencia, sin alerta)',
      labelNames: ['reason', 'purpose', 'alerted'],
      registers,
    }),
    walletVerificationFailures: new Counter({
      name: 'mtw_wallet_verification_failures_total',
      help: 'Ítems de la verificación post-deploy (V9 §16) que no coincidieron: la wallet queda FAILED (alerta)',
      labelNames: ['item'],
      registers,
    }),
    operationTransitions: new Counter({
      name: 'mtw_operation_transitions_total',
      help: 'Transiciones de wallet_operations por estado destino [B-SM]',
      labelNames: ['to'],
      registers,
    }),
    operationErrors: new Counter({
      name: 'mtw_operation_errors_total',
      help: 'Errores clasificados del pipeline de operaciones (last_error_code, [B-Q-03])',
      labelNames: ['code'],
      registers,
    }),
    workerStepDuration: new Histogram({
      name: 'mtw_worker_step_duration_seconds',
      help: 'Duración de cada paso del pipeline del worker S [B-Q-02]',
      labelNames: ['step'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers,
    }),
    executorTransactions: new Counter({
      name: 'mtw_executor_transactions_total',
      help: 'Transacciones execTransaction de S por resultado (submitted, mined, reverted, replaced, dropped, confirmed, finalized, reorged)',
      labelNames: ['result'],
      registers,
    }),
    reorgsDetected: new Counter({
      name: 'mtw_reorgs_detected_total',
      help: 'Reorgs detectados por el watcher (operación, transfer o ejecución indexada) [B-FIN-02]',
      labelNames: ['kind'],
      registers,
    }),
    rotationEventApplyFailures: new Counter({
      name: 'mtw_rotation_event_apply_failures_total',
      help: 'Intentos fallidos de aplicar un evento del RotationTimelock: el evento queda en cuarentena (alerta) y los posteriores de su Safe esperan',
      labelNames: ['kind'],
      registers,
    }),
    rotationEventsQuarantined: new Gauge({
      name: 'mtw_rotation_events_quarantined',
      help: 'Eventos del RotationTimelock en cuarentena al final de la última pasada de la sincronización de rotaciones (alerta si > 0)',
      registers,
    }),
    sovereignModified: new Counter({
      name: 'mtw_wallets_sovereign_modified_total',
      help: 'Wallets marcadas SOVEREIGN_MODIFIED por deriva de configuración de la Safe (alerta)',
      registers,
    }),
    reconcilerDiscrepancies: new Counter({
      name: 'mtw_reconciler_discrepancies_total',
      help: 'Discrepancias DB ↔ cadena detectadas por la reconciliación [B-FIN-03]',
      labelNames: ['kind'],
      registers,
    }),
    indexerHeadBlock: new Gauge({
      name: 'mtw_indexer_head_block',
      help: 'Último bloque procesado por cada indexer',
      labelNames: ['indexer'],
      registers,
    }),
    whitelistEvents: new Counter({
      name: 'mtw_whitelist_events_total',
      help: 'Eventos del ciclo de vida de la whitelist (pedido, challenge, alta on-chain, activación, baja)',
      labelNames: ['event'],
      registers,
    }),
    twoFactorChallenges: new Counter({
      name: 'mtw_two_factor_challenges_total',
      help: '2FA de operaciones de alto valor por factor y resultado',
      labelNames: ['method', 'result'],
      registers,
    }),
    swapQuotes: new Counter({
      name: 'mtw_swap_quotes_total',
      help: 'Cotizaciones de swap (QuoterV2) por resultado',
      labelNames: ['result'],
      registers,
    }),
    notificationsCreated: new Counter({
      name: 'mtw_notifications_created_total',
      help: 'Notificaciones in-app creadas por tipo',
      labelNames: ['type'],
      registers,
    }),
    frontendSecurityReports: new Counter({
      name: 'mtw_frontend_security_reports_total',
      help: 'Reportes de seguridad de los frontends (CSP/Trusted Types, service workers, CSP inactiva) por app y tipo',
      labelNames: ['client', 'type', 'directive'],
      registers,
    }),
    integrityStatus: new Gauge({
      name: 'mtw_integrity_attested_status',
      help: 'Último estado atestado por el integrity monitor por app: 0 OK, 1 UNREACHABLE, 2 MISMATCH, 3 sin atestación vigente',
      labelNames: ['app'],
      registers,
    }),
    cooperationState: new Gauge({
      name: 'mtw_cooperation_state',
      help: 'Cooperación de S según las atestaciones de integridad: 0 ACTIVE, 1 DEGRADED (UNREACHABLE en gracia), 2 PAUSED',
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
  /** Operaciones no terminales sin cambios hace más del umbral (alerta de operaciones atascadas, [B-OBS]). */
  stuckOperations?: () => Promise<number>;
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
  if (sources.stuckOperations) {
    const read = sources.stuckOperations;
    new Gauge({
      name: 'mtw_wallet_operations_stuck',
      help: 'Operaciones no terminales sin cambios de estado hace más de 10 minutos',
      registers,
      async collect() {
        this.set(await read());
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
