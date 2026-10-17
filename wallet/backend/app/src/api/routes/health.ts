// GET /api/v1/health, /health/live y /health/ready (ambos listeners).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkReadiness, type ReadinessDeps } from '../health.ts';
import { errorResponses, ProblemSchema } from '../errors.ts';

const HealthSchema = z
  .object({
    status: z.literal('ok'),
    service: z.string(),
    version: z.string(),
    listener: z.enum(['WALLET', 'RECOVERY']),
  })
  .meta({ id: 'Health' });

const LivenessSchema = z.object({ status: z.literal('ok') }).meta({ id: 'Liveness' });

const CheckSchema = z.object({ ok: z.boolean(), latencyMs: z.number().int().nullable() });

const ReadinessSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      database: CheckSchema,
      migrations: z.object({ ok: z.boolean(), pending: z.array(z.string()) }),
      valkey: CheckSchema,
      rpc: z.object({
        ok: z.boolean(),
        mode: z.enum(['local-single', 'dual']),
        providers: z.array(
          z.object({
            provider: z.string(),
            healthy: z.boolean(),
            reason: z.string(),
            head: z.string().nullable(),
            lagBlocks: z.number().int().nullable(),
          }),
        ),
      }),
    }),
  })
  .meta({ id: 'Readiness' });

export interface HealthRoutesOptions {
  version: string;
  readiness: ReadinessDeps;
}

export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, options, done) => {
  app.get(
    '/health',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'getHealth',
        tags: ['health'],
        summary: 'Estado básico del servicio',
        response: { 200: HealthSchema, ...errorResponses() },
      },
    },
    (request) => ({
      status: 'ok' as const,
      service: 'mtw-backend',
      version: options.version,
      listener: request.client,
    }),
  );

  app.get(
    '/health/live',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'getLiveness',
        tags: ['health'],
        summary: 'El proceso está vivo',
        response: { 200: LivenessSchema, ...errorResponses() },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'getReadiness',
        tags: ['health'],
        summary: 'Dependencias listas: base de datos, migraciones al día, Valkey y RPC',
        description:
          'Responde 503 con el mismo reporte si alguna dependencia no está lista (o un Problem si el request no llegó al chequeo, p. ej. Valkey caído para el rate limit).',
        response: { 200: ReadinessSchema, ...errorResponses(), 503: z.union([ReadinessSchema, ProblemSchema]) },
      },
    },
    async (_request, reply) => {
      const report = await checkReadiness(options.readiness);
      return reply.code(report.status === 'ready' ? 200 : 503).send(report);
    },
  );
  done();
};
