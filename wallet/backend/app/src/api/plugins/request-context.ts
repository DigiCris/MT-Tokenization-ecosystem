// Contexto de cada request: requestId (generado por el servidor y devuelto en X-Request-Id), cliente derivado del
// listener, respuestas sin caché, métrica de duración y una línea de log por request completado.
import type { Client } from '../../db/schema.ts';
import type { Metrics } from '../../observability/metrics.ts';
import type { AppInstance } from '../types.ts';

export function registerRequestContext(app: AppInstance, client: Client, metrics: Metrics): void {
  app.decorateRequest('client', client);
  app.decorateRequest('principal', null);
  app.decorateRequest('idempotency', null);

  app.addHook('onRequest', async (request, reply) => {
    request.client = client;
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.httpRequestDuration.observe(
      { listener: client, method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    request.log.info({ req: request, res: reply, responseTimeMs: Math.round(reply.elapsedTime) }, 'request completado');
  });
}
