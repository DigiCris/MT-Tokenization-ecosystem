// Grupo `users` de [B-API]: datos de la cuenta y preferencias no sensibles (locale y zona horaria de los emails).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AccountService, UserSummary } from '../../../auth/account-service.ts';
import { errorResponses } from '../../errors.ts';

/** Preferencias que el frontend toma del navegador (`Intl`) y el usuario puede editar. */
export const LocaleSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, { error: 'locale BCP 47 (p. ej. es-AR)' });
export const TimeZoneSchema = z
  .string()
  .max(64)
  .refine((value) => isTimeZone(value), { error: 'zona horaria IANA desconocida' });

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    emailVerified: z.boolean(),
    totpEnabled: z.boolean(),
    locale: z.string(),
    timeZone: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export function userView(user: UserSummary): z.infer<typeof UserSchema> {
  return { ...user, createdAt: user.createdAt.toISOString() };
}

/**
 * Zona horaria IANA que el runtime sabe formatear, incluidos los alias: los navegadores informan nombres distintos para
 * la misma zona (Chrome `America/Buenos_Aires`, Firefox y Safari `America/Argentina/Buenos_Aires`).
 */
export function isTimeZone(value: string): boolean {
  if (!/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface UsersRoutesOptions {
  account: AccountService;
}

export const usersRoutes: FastifyPluginCallbackZod<UsersRoutesOptions> = (app, options, done) => {
  const security = [{ sessionCookie: [], csrfToken: [] }];

  app.get(
    '/users/me',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getMe',
        tags: ['users'],
        summary: 'Datos de la cuenta de la sesión',
        security,
        response: { 200: UserSchema, ...errorResponses(401) },
      },
    },
    async (request) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      return userView(await options.account.me(request.session.userId));
    },
  );

  app.patch(
    '/users/me',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'updateMe',
        tags: ['users'],
        summary: 'Actualiza preferencias no sensibles (locale y zona horaria)',
        security,
        body: z
          .object({ locale: LocaleSchema.optional(), timeZone: TimeZoneSchema.optional() })
          .strict()
          .refine((b) => b.locale !== undefined || b.timeZone !== undefined, { error: 'nada para actualizar' }),
        response: { 200: UserSchema, ...errorResponses(401, 403, 415) },
      },
    },
    async (request) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      return userView(await options.account.updateMe(request.session.userId, request.body));
    },
  );

  done();
};
