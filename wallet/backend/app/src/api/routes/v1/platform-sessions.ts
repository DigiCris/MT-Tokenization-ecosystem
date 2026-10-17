// Grupo `sessions` de [B-API] (PlatformSession [B-PSES]): desbloqueo OPAQUE de la Wallet (sólo en su listener),
// step-up con email OTP (+ TOTP) para los scopes restringidos, revocación y verificación de la sesión firmada.
//
// El token de PlatformSession sí viaja en el cuerpo de la respuesta: es un bearer atado a una session key no exportable
// que el cliente guarda sólo en memoria y manda en `X-Platform-Session` ([B-PSES-04]). Las cookies de cuenta nunca.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuditWriter } from '../../../audit/audit-writer.ts';
import type { Client, Database } from '../../../db/schema.ts';
import { withTransaction } from '../../../db/transaction.ts';
import { P256PublicJwkSchema } from '../../../platform-session/keys.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { IssuedPlatformSession, PlatformSessionService } from '../../../platform-session/sessions.ts';
import {
  STEP_UP_LISTENER,
  STEP_UP_RATE_POLICY,
  STEP_UP_SCOPES,
  type StepUpService,
} from '../../../platform-session/step-up.ts';
import { PLATFORM_SCOPES, type PlatformSessionClaims } from '../../../platform-session/token.ts';
import type { WalletUnlockService } from '../../../platform-session/unlock.ts';
import { ApiError, errorResponses } from '../../errors.ts';
import { applySession, requestMeta } from './auth.ts';
import type { Kysely } from 'kysely';

const B64URL = /^[A-Za-z0-9_-]+$/;
const OpaqueMessage = z.string().min(16).max(4096).regex(B64URL, { error: 'mensaje OPAQUE en base64url' });
const Otp = z.string().regex(/^\d{8}$/, { error: 'el código tiene 8 dígitos' });
const TotpCode = z.string().regex(/^\d{6}$/, { error: 'el código TOTP tiene 6 dígitos' });
const RecoveryCode = z.string().regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, { error: 'código de recuperación inválido' });

export const PlatformSessionViewSchema = z
  .object({
    id: z.uuid(),
    scope: z.enum(PLATFORM_SCOPES),
    authMethod: z.enum(['OPAQUE_U', 'STEP_UP']),
    walletId: z.uuid().nullable(),
    safe: z.string().nullable(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PlatformSession' });

const IssuedSchema = z
  .object({
    token: z.string().describe('JWS EdDSA para el header X-Platform-Session'),
    session: PlatformSessionViewSchema,
  })
  .meta({ id: 'IssuedPlatformSession' });

export function platformSessionView(claims: PlatformSessionClaims): z.infer<typeof PlatformSessionViewSchema> {
  return {
    id: claims.sessionId,
    scope: claims.scope,
    authMethod: claims.authMethod,
    walletId: claims.walletId,
    safe: claims.safe,
    issuedAt: new Date(claims.issuedAt * 1000).toISOString(),
    expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
  };
}

const issuedView = (issued: IssuedPlatformSession) => ({
  token: issued.token,
  session: platformSessionView(issued.claims),
});

export interface PlatformSessionsRoutesOptions {
  client: Client;
  db: Kysely<Database>;
  audit: AuditWriter;
  platformSessions: PlatformSessionService;
  stepUp: StepUpService;
  /** Sólo en el listener de Wallet (el desbloqueo con U no existe en Recovery). */
  unlock: WalletUnlockService | null;
  csrfForSession: (sessionId: string) => string;
}

const security = [{ sessionCookie: [], csrfToken: [] }];

export const platformSessionsRoutes: FastifyPluginCallbackZod<PlatformSessionsRoutesOptions> = (app, options, done) => {
  const tags = ['platform-sessions'];
  const { unlock } = options;

  if (unlock) {
    app.post(
      '/platform-sessions/opaque/start',
      {
        config: { auth: 'account' },
        schema: {
          operationId: 'startOpaqueLogin',
          tags,
          summary: 'Desbloqueo de la Wallet, paso 1: pedido OPAQUE (KE1) y session key P-256 a atar',
          security,
          body: z.object({ startLoginRequest: OpaqueMessage, sessionPublicKey: P256PublicJwkSchema }).strict(),
          response: {
            200: z.object({ loginAttemptId: z.uuid(), loginResponse: z.string(), expiresAt: z.iso.datetime() }),
            ...errorResponses(401, 403, 409, 415),
          },
        },
      },
      async (request) => {
        const session = request.session;
        if (!session) throw new Error('ruta de cuenta sin sesión');
        await app.enforceRateLimit(request, 'opaque-login', { user: session.userId, session: session.sessionId });
        const started = await unlock.start({ session, ...request.body });
        return { ...started, expiresAt: started.expiresAt.toISOString() };
      },
    );

    app.post(
      '/platform-sessions/opaque/finish',
      {
        config: { auth: 'account' },
        schema: {
          operationId: 'finishOpaqueLogin',
          tags,
          summary:
            'Desbloqueo de la Wallet, paso 2: mensaje final OPAQUE (KE3) y binding de la session key → OPERATIONS',
          security,
          body: z
            .object({
              loginAttemptId: z.uuid(),
              finishLoginRequest: OpaqueMessage,
              sessionKeyBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/, { error: 'HMAC-SHA256 en base64url' }),
            })
            .strict(),
          response: { 200: IssuedSchema, ...errorResponses(401, 403, 415) },
        },
      },
      async (request) => {
        const session = request.session;
        if (!session) throw new Error('ruta de cuenta sin sesión');
        return issuedView(await unlock.finish({ session, ...request.body, meta: requestMeta(request) }));
      },
    );
  }

  app.post(
    '/platform-sessions/step-up/start',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'startStepUp',
        tags,
        summary: 'Step-up: envía un código por email para un scope restringido, atado a la session key',
        security,
        body: z.object({ scope: z.enum(STEP_UP_SCOPES), sessionPublicKey: P256PublicJwkSchema }).strict(),
        response: {
          202: z.object({ challengeId: z.uuid(), expiresAt: z.iso.datetime() }),
          ...errorResponses(401, 403, 409, 415),
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      // El scope de otra app se rechaza antes de gastar cupo de rate limit.
      if (STEP_UP_LISTENER[request.body.scope] !== request.client) throw new ApiError('SCOPE_NOT_ALLOWED');
      await app.enforceRateLimit(request, STEP_UP_RATE_POLICY[request.body.scope], { user: session.userId });
      await app.enforceRateLimit(request, 'otp-challenge', { user: session.userId, challengeType: 'STEP_UP' });
      const started = await options.stepUp.start({ session, ...request.body, meta: requestMeta(request) });
      return reply.code(202).send({ challengeId: started.challengeId, expiresAt: started.expiresAt.toISOString() });
    },
  );

  app.post(
    '/platform-sessions/step-up/finish',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'finishStepUp',
        tags,
        summary: 'Step-up: código del email (+ TOTP si está activo) → PlatformSession del scope pedido; rota la sesión',
        security,
        body: z
          .object({
            challengeId: z.uuid(),
            code: Otp,
            totp: TotpCode.optional(),
            recoveryCode: RecoveryCode.optional(),
          })
          .strict()
          .refine((b) => b.totp === undefined || b.recoveryCode === undefined, {
            error: 'enviar TOTP o código de recuperación, no ambos',
          }),
        response: {
          200: IssuedSchema.extend({ csrfToken: z.string().describe('Token CSRF de la sesión de cuenta rotada') }),
          ...errorResponses(401, 403, 409, 415),
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      const result = await options.stepUp.finish({ session, ...request.body, meta: requestMeta(request) });
      const csrfToken = applySession(request, reply, result.account, options.csrfForSession);
      return { ...issuedView(result.platform), csrfToken };
    },
  );

  app.post(
    '/platform-sessions/check',
    {
      config: { auth: 'account', platformSession: { scopes: PLATFORM_SCOPES, critical: true } },
      schema: {
        operationId: 'checkPlatformSession',
        tags,
        summary: 'Verifica la PlatformSession y la firma del request (prueba de la session key, sin efectos)',
        security: [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }],
        headers: CriticalRequestHeadersSchema,
        body: z.object({}).strict(),
        response: { 200: PlatformSessionViewSchema, ...errorResponses(401, 403, 415) },
      },
    },
    (request) => {
      if (!request.platformSession) throw new Error('ruta crítica sin PlatformSession');
      return platformSessionView(request.platformSession.claims);
    },
  );

  app.delete(
    '/platform-sessions/:id',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'revokePlatformSession',
        tags,
        summary: 'Revoca una PlatformSession propia (p. ej. al bloquear la wallet)',
        security,
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null().describe('PlatformSession revocada'), ...errorResponses(401, 403, 404, 415) },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      const meta = requestMeta(request);
      const revoked = await withTransaction(
        options.db,
        async (trx) => {
          const ok = await options.platformSessions.revoke(trx, {
            userId: session.userId,
            sessionId: request.params.id,
          });
          if (ok) {
            await options.audit.append(trx, {
              actorType: 'USER',
              actorId: session.userId,
              userId: session.userId,
              sessionId: session.sessionId,
              eventType: 'PLATFORM_SESSION_REVOKED',
              requestId: meta.requestId,
              ipPrefix: meta.ipPrefix,
              payload: { client: meta.client, platformSessionId: request.params.id },
            });
          }
          return ok;
        },
        { auditLock: true },
      );
      if (!revoked) throw new ApiError('NOT_FOUND');
      return reply.code(204).send(null);
    },
  );

  done();
};
