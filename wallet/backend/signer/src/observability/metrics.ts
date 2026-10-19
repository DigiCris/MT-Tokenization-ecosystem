// Métricas Prometheus del signer [B-OBS]: firmas emitidas, rechazos por motivo, latencia, estado del shard y de las
// claves (BROKEN, faltantes, sobrantes), saldo de la cuenta gas tank. Registro propio (no el global).
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface SignerMetrics {
  registry: Registry;
  signatures: Counter<'kind'>;
  rejections: Counter<'reason'>;
  requestDuration: Histogram<'route' | 'status'>;
  ready: Gauge;
  keys: Gauge<'status'>;
  keystoreAlarms: Counter<'alarm'>;
  cooperationPaused: Counter<'reason'>;
}

export function createMetrics(options: { defaultMetrics?: boolean } = {}): SignerMetrics {
  const registry = new Registry();
  if (options.defaultMetrics !== false) collectDefaultMetrics({ register: registry, prefix: 'mtw_signer_' });
  return {
    registry,
    signatures: new Counter({
      name: 'mtw_signer_signatures_total',
      help: 'Firmas emitidas por tipo (safe_tx, platform_tx).',
      labelNames: ['kind'],
      registers: [registry],
    }),
    rejections: new Counter({
      name: 'mtw_signer_rejections_total',
      help: 'Pedidos de firma rechazados por motivo.',
      labelNames: ['reason'],
      registers: [registry],
    }),
    requestDuration: new Histogram({
      name: 'mtw_signer_request_duration_seconds',
      help: 'Duración de los pedidos a la API mTLS.',
      labelNames: ['route', 'status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    ready: new Gauge({
      name: 'mtw_signer_ready',
      help: '1 si el shard está listo para firmar.',
      registers: [registry],
    }),
    keys: new Gauge({
      name: 'mtw_signer_keys',
      help: 'Claves del shard por estado.',
      labelNames: ['status'],
      registers: [registry],
    }),
    keystoreAlarms: new Counter({
      name: 'mtw_signer_keystore_alarms_total',
      help: 'Alarmas del keystore (MAC inválido, archivo faltante o sobrante, fingerprint distinto, permisos).',
      labelNames: ['alarm'],
      registers: [registry],
    }),
    cooperationPaused: new Counter({
      name: 'mtw_signer_cooperation_paused_total',
      help: 'Co-firmas rechazadas por la pausa de integridad (P20.T03), por app y motivo.',
      labelNames: ['reason'],
      registers: [registry],
    }),
  };
}
