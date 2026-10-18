// Grupo `notifications` de [B-API] (P15.T07): notificaciones in-app de la cuenta en los dos listeners (la misma
// bandeja en Wallet y Recovery). Sesión de cuenta; una notificación de otro usuario responde 404 ([B-AUTHZ]).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotificationService } from '../../../notifications/service.ts';
import { errorResponses } from '../../errors.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];

export const NotificationSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid().nullable(),
    type: z
      .string()
      .describe('Evento de [B-MAIL-03] (p. ej. ROTATION_PROPOSED, WHITELIST_ACTIVATED, RECOVERY_STARTED)'),
    payload: z.record(z.string(), z.unknown()),
    readAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Notification' });

export interface NotificationRoutesOptions {
  notifications: NotificationService;
}

export const notificationRoutes: FastifyPluginCallbackZod<NotificationRoutesOptions> = (app, options, done) => {
  const tags = ['notifications'];
  const { notifications } = options;

  app.get(
    '/notifications',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'listNotifications',
        tags,
        summary: 'Notificaciones in-app de la cuenta (más recientes primero, paginadas por cursor)',
        security: accountSecurity,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          before: z.uuid().optional().describe('Cursor: id de la última notificación de la página anterior'),
          unread: z.enum(['true', 'false']).optional().describe('true: sólo las no leídas'),
        }),
        response: {
          200: z.object({
            items: z.array(NotificationSchema),
            unread: z.number().int().describe('Total de notificaciones sin leer'),
            nextCursor: z.uuid().nullable(),
          }),
          ...errorResponses(401, 404),
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return notifications.list(session.userId, {
        limit: request.query.limit,
        ...(request.query.before === undefined ? {} : { before: request.query.before }),
        unreadOnly: request.query.unread === 'true',
      });
    },
  );

  app.post(
    '/notifications/:id/read',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'markNotificationRead',
        tags,
        summary: 'Marca una notificación como leída (idempotente)',
        security: accountSecurity,
        params: z.object({ id: z.uuid() }),
        body: z.object({}).strict(),
        response: { 200: NotificationSchema, ...errorResponses(401, 403, 404, 415) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return notifications.markRead(session.userId, request.params.id);
    },
  );

  done();
};
