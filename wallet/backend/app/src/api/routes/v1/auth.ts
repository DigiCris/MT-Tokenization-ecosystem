// Grupo `auth` de [B-API] (ambos listeners): registro, verificación de email, login/logout, CSRF, olvido y reset de
// password, desbloqueo y TOTP. La API nunca devuelve tokens de sesión en el body: la sesión viaja sólo en la cookie
// `__Host-` del listener ([B-AUTH-04]).
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  normalizeEmail,
  type AccountService,
  type NewSession,
  type RequestMeta,
} from '../../../auth/account-service.ts';
import { PASSWORD_MAX_LENGTH } from '../../../auth/password.ts';
import { SESSION_COOKIE } from '../../../auth/sessions.ts';
import { truncateIp } from '../../../observability/redaction.ts';
import { errorResponses } from '../../errors.ts';
import { clearSessionCookie, sessionCookieOptions } from '../../plugins/auth.ts';
import { LocaleSchema, TimeZoneSchema, UserSchema, userView } from './users.ts';

const Email = z.email({ error: 'email inválido' }).max(254);
const Password = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4);
const Otp = z.string().regex(/^\d{8}$/, { error: 'el código tiene 8 dígitos' });
const TotpCode = z.string().regex(/^\d{6}$/, { error: 'el código TOTP tiene 6 dígitos' });
const RecoveryCode = z.string().regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, { error: 'código de recuperación inválido' });

const AcceptedSchema = z.object({ status: z.literal('ACCEPTED') }).meta({ id: 'Accepted' });
const CsrfSchema = z.object({ csrfToken: z.string() }).meta({ id: 'CsrfToken' });
const LoginResponseSchema = z
  .object({
    user: UserSchema,
    csrfToken: z.string().describe('Token CSRF de la sesión nueva (pedirlo de nuevo no hace falta)'),
  })
  .meta({ id: 'LoginResponse' });

export function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    client: request.client,
    ipKey: request.ip ? normalizeIP(request.ip, 64) : null,
    ipPrefix: request.ip ? truncateIp(request.ip) : null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: request.id,
    currentSessionId: request.session?.sessionId ?? null,
  };
}

/** Fija la cookie de la sesión nueva y devuelve su token CSRF. */
export function applySession(
  request: FastifyRequest,
  reply: FastifyReply,
  session: NewSession,
  csrfFor: (sessionId: string) => string,
): string {
  const maxAge = Math.max(1, Math.floor((session.absoluteExpiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(SESSION_COOKIE[request.client], session.token, sessionCookieOptions(maxAge));
  return csrfFor(session.sessionId);
}

export interface AuthRoutesOptions {
  account: AccountService;
  csrfForSession: (sessionId: string) => string;
}

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];

export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (app, options, done) => {
  const { account, csrfForSession } = options;
  const tags = ['auth'];

  app.get(
    '/auth/csrf',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'getCsrfToken',
        tags,
        summary: 'Token CSRF para los requests no-GET (atado a la sesión o, sin sesión, a una cookie anónima)',
        response: { 200: CsrfSchema, ...errorResponses() },
      },
    },
    (request, reply) => ({ csrfToken: app.issueCsrfToken(request, reply) }),
  );

  app.post(
    '/auth/register',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'register',
        tags,
        summary: 'Registro de cuenta: envía el código de verificación al email (misma respuesta exista o no la cuenta)',
        body: z.object({
          email: Email,
          password: Password,
          locale: LocaleSchema.optional().describe('Idioma de los emails (del navegador); default es-AR'),
          timeZone: TimeZoneSchema.optional().describe('Zona horaria IANA de los emails (del navegador); default UTC'),
        }),
        response: { 202: AcceptedSchema, ...errorResponses(403, 415, 422) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'otp-challenge', {
        user: `email:${normalizeEmail(request.body.email)}`,
        challengeType: 'EMAIL_VERIFY',
      });
      await account.register({ ...request.body, meta: requestMeta(request) });
      return reply.code(202).send({ status: 'ACCEPTED' as const });
    },
  );

  app.post(
    '/auth/verify-email',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'verifyEmail',
        tags,
        summary: 'Verifica el email con el código de 8 dígitos e inicia la sesión',
        body: z.object({ email: Email, code: Otp }),
        response: { 200: LoginResponseSchema, ...errorResponses(403, 415) },
      },
    },
    async (request, reply) => {
      const session = await account.verifyEmail({ ...request.body, meta: requestMeta(request) });
      const csrfToken = applySession(request, reply, session, csrfForSession);
      return { user: userView(session.user), csrfToken };
    },
  );

  app.post(
    '/auth/verify-email/resend',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'resendEmailVerification',
        tags,
        summary: 'Reenvía el código de verificación (misma respuesta exista o no la cuenta)',
        body: z.object({ email: Email }),
        response: { 202: AcceptedSchema, ...errorResponses(403, 415) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'otp-challenge', {
        user: `email:${normalizeEmail(request.body.email)}`,
        challengeType: 'EMAIL_VERIFY',
      });
      await account.resendVerification({ email: request.body.email, meta: requestMeta(request) });
      return reply.code(202).send({ status: 'ACCEPTED' as const });
    },
  );

  app.post(
    '/auth/login',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'login',
        tags,
        summary: 'Login con email y contraseña (y TOTP o código de recuperación si está activo)',
        body: z
          .object({
            email: Email,
            password: Password,
            totp: TotpCode.optional(),
            recoveryCode: RecoveryCode.optional(),
          })
          .refine((b) => b.totp === undefined || b.recoveryCode === undefined, {
            error: 'enviar TOTP o código de recuperación, no ambos',
          }),
        response: { 200: LoginResponseSchema, ...errorResponses(401, 403, 415) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'login', { email: normalizeEmail(request.body.email) });
      const session = await account.login({ ...request.body, meta: requestMeta(request) });
      const csrfToken = applySession(request, reply, session, csrfForSession);
      return { user: userView(session.user), csrfToken };
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'logout',
        tags,
        summary: 'Cierra la sesión actual y sus PlatformSessions',
        security: accountSecurity,
        body: z.object({}).strict(),
        response: { 204: z.null().describe('Sesión cerrada'), ...errorResponses(401, 403, 415) },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session) await account.logout(session, requestMeta(request));
      clearSessionCookie(reply, request.client);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'forgotPassword',
        tags,
        summary: 'Envía un enlace de restablecimiento al email (misma respuesta exista o no la cuenta)',
        body: z.object({ email: Email }),
        response: { 202: AcceptedSchema, ...errorResponses(403, 415) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'forgot-password', { email: normalizeEmail(request.body.email) });
      await account.requestPasswordReset({ email: request.body.email, meta: requestMeta(request) });
      return reply.code(202).send({ status: 'ACCEPTED' as const });
    },
  );

  app.post(
    '/auth/reset-password',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'resetPassword',
        tags,
        summary:
          'Restablece la contraseña con el token del email; cierra todas las sesiones (no toca claves de la wallet)',
        body: z.object({ token: z.string().max(200), newPassword: Password }),
        response: { 204: z.null().describe('Contraseña restablecida'), ...errorResponses(403, 415, 422) },
      },
    },
    async (request, reply) => {
      await account.resetPassword({ ...request.body, meta: requestMeta(request) });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/unlock/request',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'requestAccountUnlock',
        tags,
        summary: 'Envía el código de desbloqueo de una cuenta bloqueada (misma respuesta en cualquier caso)',
        body: z.object({ email: Email }),
        response: { 202: AcceptedSchema, ...errorResponses(403, 415) },
      },
    },
    async (request, reply) => {
      await app.enforceRateLimit(request, 'otp-challenge', {
        user: `email:${normalizeEmail(request.body.email)}`,
        challengeType: 'LOGIN_UNLOCK',
      });
      await account.requestUnlock({ email: request.body.email, meta: requestMeta(request) });
      return reply.code(202).send({ status: 'ACCEPTED' as const });
    },
  );

  app.post(
    '/auth/unlock',
    {
      config: { auth: 'public' },
      schema: {
        operationId: 'unlockAccount',
        tags,
        summary: 'Desbloquea la cuenta con el código del email',
        body: z.object({ email: Email, code: Otp }),
        response: { 204: z.null().describe('Cuenta desbloqueada'), ...errorResponses(403, 415) },
      },
    },
    async (request, reply) => {
      await account.unlock({ ...request.body, meta: requestMeta(request) });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/totp/setup',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'setupTotp',
        tags,
        summary: 'Genera un secreto TOTP pendiente de confirmación (URI otpauth para el QR)',
        security: accountSecurity,
        body: z.object({}).strict(),
        response: {
          200: z.object({ otpauthUri: z.string(), secret: z.string().describe('Secreto en base32 (carga manual)') }),
          ...errorResponses(401, 403, 409, 415),
        },
      },
    },
    async (request) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      return account.totpSetup(request.session);
    },
  );

  app.post(
    '/auth/totp/enable',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'enableTotp',
        tags,
        summary: 'Confirma el TOTP con un código; devuelve los 10 códigos de recuperación (se muestran una sola vez)',
        security: accountSecurity,
        body: z.object({ code: TotpCode }),
        response: {
          200: z.object({ recoveryCodes: z.array(z.string()).length(10), csrfToken: z.string() }),
          ...errorResponses(401, 403, 409, 415),
        },
      },
    },
    async (request, reply) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      const result = await account.totpEnable(request.session, request.body.code, requestMeta(request));
      const csrfToken = applySession(request, reply, result.session, csrfForSession);
      return { recoveryCodes: result.recoveryCodes, csrfToken };
    },
  );

  app.post(
    '/auth/totp/disable',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'disableTotp',
        tags,
        summary: 'Desactiva el TOTP con la contraseña y un código TOTP o de recuperación',
        security: accountSecurity,
        body: z
          .object({ password: Password, totp: TotpCode.optional(), recoveryCode: RecoveryCode.optional() })
          .refine((b) => (b.totp === undefined) !== (b.recoveryCode === undefined), {
            error: 'enviar TOTP o código de recuperación',
          }),
        response: { 200: CsrfSchema, ...errorResponses(401, 403, 409, 415) },
      },
    },
    async (request, reply) => {
      if (!request.session) throw new Error('ruta de cuenta sin sesión');
      const session = await account.totpDisable(request.session, request.body, requestMeta(request));
      return { csrfToken: applySession(request, reply, session, csrfForSession) };
    },
  );

  done();
};
