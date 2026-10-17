// Plugin de PlatformSession [B-PSES-04/05], [B-AUTHZ]: las rutas con `config.platformSession` exigen, además de la
// sesión de cuenta, el token del header `X-Platform-Session` (firma, vigencia, fila no revocada, misma sesión de cuenta
// padre) con un scope permitido para la ruta; las críticas, también la firma del request con la session key.
//
// Corre en preValidation, después de la autenticación de cuenta y del CSRF (plugins/auth.ts) y antes de validar el body
// y de reclamar el Idempotency-Key: un request sin sesión válida o mal firmado no consume nada.
//
// Todas las fallas de esta capa son 403 con un código propio (no 401: la sesión de cuenta sigue vigente y el frontend
// sólo tiene que volver a desbloquear o reintentar).
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../api/errors.ts';
import type { AppInstance } from '../api/types.ts';
import { isInfrastructureRoute } from '../api/plugins/openapi.ts';
import { RequestSignatureError, verifyCriticalRequest, type RequestNonceStore } from './request-signature.ts';
import { PlatformSessionError, type PlatformSessionService, type VerifiedPlatformSession } from './sessions.ts';
import { PlatformSessionTokenError, type PlatformScope } from './token.ts';

export const PLATFORM_SESSION_HEADER = 'x-platform-session';

export interface PlatformSessionRouteConfig {
  /** Scopes que pueden usar la ruta ([W-07]). */
  scopes: readonly PlatformScope[];
  /** Request crítico: exige además `X-Session-Signature` ([B-PSES-05]). */
  critical?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    platformSession?: PlatformSessionRouteConfig;
  }
  interface FastifyRequest {
    platformSession: VerifiedPlatformSession | null;
    /** Bytes exactos del cuerpo JSON (la firma de un request crítico cubre su SHA-256). */
    rawBody: Buffer | null;
  }
}

export interface PlatformSessionPluginOptions {
  sessions: PlatformSessionService;
  nonces: RequestNonceStore;
}

const SIGNATURE_ERRORS = {
  MISSING: 'REQUEST_SIGNATURE_INVALID',
  MALFORMED: 'REQUEST_SIGNATURE_INVALID',
  SIGNATURE: 'REQUEST_SIGNATURE_INVALID',
  EXPIRED: 'REQUEST_EXPIRED',
  REPLAYED: 'REQUEST_REPLAYED',
} as const;

export function registerPlatformSessions(app: AppInstance, options: PlatformSessionPluginOptions): void {
  app.decorateRequest('platformSession', null);
  app.decorateRequest('rawBody', null);

  // Parser JSON que conserva los bytes recibidos (el mismo parser seguro de Fastify, contra prototype poisoning).
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const bytes = body as Buffer;
    request.rawBody = bytes;
    void parseJson(request, bytes.toString('utf8'), done);
  });

  app.addHook('onRoute', (route) => {
    if (isInfrastructureRoute(route)) return;
    const config = route.config as { auth?: unknown; platformSession?: PlatformSessionRouteConfig } | undefined;
    const platformSession = config?.platformSession;
    if (!platformSession) return;
    const where = `${String(route.method)} ${route.url}`;
    if (config.auth !== 'account') throw new Error(`ruta con PlatformSession sin sesión de cuenta: ${where}`);
    if (platformSession.scopes.length === 0) throw new Error(`ruta con PlatformSession sin scopes: ${where}`);
    const statuses = Object.keys((route.schema as { response?: Record<string, unknown> } | undefined)?.response ?? {});
    if (!statuses.includes('403'))
      throw new Error(`ruta con PlatformSession sin documentar la respuesta 403: ${where}`);
  });

  app.addHook('preValidation', async (request: FastifyRequest) => {
    const required = request.routeOptions.config.platformSession;
    if (!required) return;
    const account = request.session;
    // La autenticación de cuenta corre antes y ya devolvió 401; esto es una defensa.
    if (!account) throw new ApiError('UNAUTHENTICATED');
    const token = request.headers[PLATFORM_SESSION_HEADER];
    if (typeof token !== 'string' || token === '') throw new ApiError('PLATFORM_SESSION_REQUIRED');
    let verified: VerifiedPlatformSession;
    try {
      verified = await options.sessions.authenticate(token, { sessionId: account.sessionId, userId: account.userId });
    } catch (error) {
      if (error instanceof PlatformSessionTokenError || error instanceof PlatformSessionError) {
        throw new ApiError('PLATFORM_SESSION_INVALID');
      }
      throw error;
    }
    if (!required.scopes.includes(verified.claims.scope)) throw new ApiError('SCOPE_NOT_ALLOWED');
    if (required.critical) {
      try {
        await verifyCriticalRequest({
          method: request.method,
          path: request.url,
          body: request.rawBody ?? Buffer.alloc(0),
          headers: request.headers,
          sessionId: verified.claims.sessionId,
          sessionPublicKey: verified.claims.sessionPublicKey,
          nonces: options.nonces,
        });
      } catch (error) {
        if (error instanceof RequestSignatureError) throw new ApiError(SIGNATURE_ERRORS[error.problem]);
        throw error;
      }
    }
    request.platformSession = verified;
  });
}
