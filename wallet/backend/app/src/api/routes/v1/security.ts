// Reportes de seguridad de los frontends (P16.T04, [F-SEC-02]/[F-SEC-04]) en los dos listeners: violaciones de CSP y
// Trusted Types, service workers encontrados y desregistrados al arrancar, y CSP inactiva. Los envía la propia app sin
// cookies (también antes del login), así que la ruta es pública y sin CSRF; tiene un bucket de rate limit propio por
// IP y sólo deja un log estructurado y una métrica. El schema acota cada campo a datos no sensibles: rutas sin query
// ni fragmento, el nombre de la directiva y, de la muestra, sólo el sink o el nombre de la política de Trusted Types.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Metrics } from '../../../observability/metrics.ts';
import { errorResponses } from '../../errors.ts';
import { requestMeta } from './auth.ts';

/** Ruta del documento o del script, sin query ni fragmento (pueden llevar tokens o datos del usuario). */
const PathOnly = z
  .string()
  .max(512)
  .regex(/^\/[^\s?#]*$/, { error: 'ruta absoluta sin query ni fragmento' });

/** Recurso bloqueado: una palabra clave del navegador o un origin con su ruta, sin query ni fragmento. */
const Blocked = z
  .string()
  .max(512)
  .regex(/^(inline|eval|wasm-eval|data|blob|trusted-types-sink|trusted-types-policy|https?:\/\/[^\s?#]+)$/, {
    error: 'palabra clave del navegador u origin con ruta, sin query ni fragmento',
  });

const ReleaseId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.@+-]{0,79}$/)
  .describe('releaseId del manifest firmado de la app que reporta');

const Position = z.int().min(0).max(10_000_000).nullable();

export const SecurityReportSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('CSP_VIOLATION'),
        releaseId: ReleaseId,
        documentPath: PathOnly,
        directive: z
          .string()
          .regex(/^[a-z-]{1,64}$/)
          .describe('effectiveDirective de la violación'),
        disposition: z.enum(['enforce', 'report']),
        blocked: Blocked,
        sourcePath: PathOnly.nullable().describe('Script propio que provocó la violación (sólo la ruta)'),
        line: Position,
        column: Position,
        sample: z
          .string()
          .regex(/^[A-Za-z][\w .-]{0,63}$/)
          .nullable()
          .describe('Sólo el sink (p. ej. "Element innerHTML") o el nombre de la política de Trusted Types'),
      })
      .strict(),
    z
      .object({
        type: z.literal('SERVICE_WORKER_REMOVED'),
        releaseId: ReleaseId,
        documentPath: PathOnly,
        scope: PathOnly.describe('Scope del service worker desregistrado (sólo la ruta)'),
      })
      .strict(),
    z
      .object({
        type: z.literal('CSP_INACTIVE'),
        releaseId: ReleaseId,
        documentPath: PathOnly,
        check: z
          .enum(['TRUSTED_TYPES_UNSUPPORTED', 'TRUSTED_TYPES_NOT_ENFORCED'])
          .describe('Comprobación de arranque que falló: la app se niega a operar'),
      })
      .strict(),
  ])
  .meta({ id: 'FrontendSecurityReport' });

export type SecurityReport = z.infer<typeof SecurityReportSchema>;

export interface SecurityRoutesOptions {
  metrics: Metrics;
}

export const securityRoutes: FastifyPluginCallbackZod<SecurityRoutesOptions> = (app, options, done) => {
  const tags = ['security'];
  const { metrics } = options;

  app.post(
    '/security/csp-report',
    {
      // Sin sesión ni CSRF: la app lo envía con `credentials: 'omit'`, antes o después del login.
      config: { auth: 'public', csrf: false },
      schema: {
        operationId: 'reportFrontendSecurityEvent',
        tags,
        summary:
          'Sin autenticación: reporte de la app (violación de CSP/Trusted Types, service worker desregistrado o CSP inactiva); sólo log y métrica',
        security: [],
        body: SecurityReportSchema,
        response: { 204: z.null().describe('Reporte registrado'), ...errorResponses(415, 422) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'csp-report', {});
      const report = request.body;
      const meta = requestMeta(request);
      const directive =
        report.type === 'CSP_VIOLATION' ? report.directive : report.type === 'CSP_INACTIVE' ? report.check : 'none';
      metrics.frontendSecurityReports.inc({ client: request.client, type: report.type, directive });
      request.log.warn({ event: 'frontend_security_report', client: request.client, ipPrefix: meta.ipPrefix, report });
      return reply.code(204).send(null);
    },
  );

  done();
};
