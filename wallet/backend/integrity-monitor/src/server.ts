// API interna del monitor (red `backend`, sin puertos publicados): atestaciones vigentes para el backend (que las
// adjunta a cada pedido de co-firma al signer), estado por app para los operadores, aprobaciones de reanudación
// (firmadas por cada operador con su clave propia: el transporte no las autentica, la firma sí), health y métricas.
import Fastify, { type FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Gauge, Counter, Registry } from 'prom-client';
import { ResumeApprovalSchema } from './approvals.ts';
import { APPS, type App, type Status } from './check.ts';
import { ApprovalRejected, type IntegrityMonitor } from './monitor.ts';

const STATUS_VALUE: Record<Status, number> = { OK: 0, UNREACHABLE: 1, MISMATCH: 2 };

export interface MonitorMetrics {
  registry: Registry;
  observe: (app: App, checkStatus: Status, attested: Status, paused: boolean) => void;
}

export function createMetrics(): MonitorMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const status = new Gauge({
    name: 'mtw_integrity_status',
    help: 'Estado atestado por app: 0 OK, 1 UNREACHABLE, 2 MISMATCH',
    labelNames: ['app'],
    registers: [registry],
  });
  const paused = new Gauge({
    name: 'mtw_integrity_paused',
    help: '1 si la cooperación de S está pausada por integridad para la app',
    labelNames: ['app'],
    registers: [registry],
  });
  const checks = new Counter({
    name: 'mtw_integrity_checks_total',
    help: 'Chequeos de integridad por app y resultado',
    labelNames: ['app', 'status'],
    registers: [registry],
  });
  const lastCheck = new Gauge({
    name: 'mtw_integrity_last_check_timestamp_seconds',
    help: 'Último chequeo completado por app',
    labelNames: ['app'],
    registers: [registry],
  });
  return {
    registry,
    observe: (app, checkStatus, attested, isPaused) => {
      status.set({ app }, STATUS_VALUE[attested]);
      paused.set({ app }, isPaused ? 1 : 0);
      checks.inc({ app, status: checkStatus });
      lastCheck.set({ app }, Math.floor(Date.now() / 1000));
    },
  };
}

export function buildServer(monitor: IntegrityMonitor, metrics: MonitorMetrics): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 4_096 });

  app.get('/health', () => ({ status: 'ok' }));
  app.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  app.get('/v1/attestations', () => ({ attestations: monitor.attestations() }));
  app.get('/v1/status', () => ({ apps: APPS.map((a) => monitor.status(a)) }));
  app.post('/v1/resume-approvals', async (request, reply) => {
    const parsed = ResumeApprovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_APPROVAL' });
    try {
      return await reply.code(202).send(monitor.approve(parsed.data));
    } catch (error) {
      if (error instanceof ApprovalRejected)
        return reply.code(409).send({ error: 'APPROVAL_REJECTED', reason: error.message });
      throw error;
    }
  });
  return app;
}
