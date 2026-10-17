// Grupo `sessions` de [B-API] (sesiones de cuenta): listado con dispositivo y última actividad y revocación
// individual o de todas las demás ([B-AUTH-04]). Una sesión de otro usuario responde 404 ([B-AUTHZ]).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AccountService } from '../../../auth/account-service.ts';
import { errorResponses } from '../../errors.ts';
import { clearSessionCookie } from '../../plugins/auth.ts';
import { requestMeta } from './auth.ts';

const SessionSchema = z
  .object({
    id: z.uuid(),
    client: z.enum(['WALLET', 'RECOVERY']),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    ipPrefix: z.string().nullable(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  })
  .meta({ id: 'AccountSession' });

export interface SessionsRoutesOptions {
  account: AccountService;
}

export const sessionsRoutes: FastifyPluginCallbackZod<SessionsRoutesOptions> = (app, options, done) => {
  const security = [{ sessionCookie: [], csrfToken: [] }];
  const tags = ['sessions'];

  app.get(
    '/sessions',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'listSessions',
        tags,
        summary: 'Sesiones vigentes de la cuenta',
        security,
        response: { 200: z.object({ sessions: z.array(SessionSchema) }), ...errorResponses(401) },
      },
    },
    async (request) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      const sessions = await options.account.listSessions(request.session);
      return {
        sessions: sessions.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    '/sessions/:id',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'revokeSession',
        tags,
        summary: 'Revoca una sesión de la cuenta (y sus PlatformSessions)',
        security,
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null().describe('Sesión revocada'), ...errorResponses(401, 403, 404, 415) },
      },
    },
    async (request, reply) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      const { current } = await options.account.revokeSession(request.session, request.params.id, requestMeta(request));
      if (current) clearSessionCookie(reply, request.client);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/sessions',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'revokeOtherSessions',
        tags,
        summary: 'Revoca todas las sesiones de la cuenta menos la actual',
        security,
        response: { 200: z.object({ revoked: z.number().int().nonnegative() }), ...errorResponses(401, 403, 415) },
      },
    },
    async (request) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      return { revoked: await options.account.revokeOtherSessions(request.session, requestMeta(request)) };
    },
  );

  done();
};
