// Autenticación de cuenta y CSRF por listener ([B-AUTH-04/05]).
//
// - La cookie de sesión del listener (`__Host-mtw_sid` / `__Host-mtr_sid`) va firmada con SESSION_SECRET: una cookie
//   adulterada se descarta sin consultar la base. Una sesión vencida o revocada borra la cookie.
// - Toda ruta de la API declara `config.auth` ('public' | 'account') y documenta sus errores de sesión y CSRF; si no,
//   el servidor no arranca.
// - Todo método no seguro exige: Origin presente (el CORS del listener ya rechaza los no permitidos),
//   `Content-Type: application/json` si lleva cuerpo (POST/PUT/PATCH siempre) y `X-CSRF-Token` atado a la sesión o,
//   sin sesión, al id anónimo de la cookie `__Host-mtw_csrf` / `__Host-mtr_csrf`.
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ANON_CSRF_COOKIE,
  ANON_CSRF_MAX_AGE_SECONDS,
  CSRF_HEADER,
  csrfToken,
  csrfTokenMatches,
  newAnonId,
  type CsrfBinding,
} from '../../auth/csrf.ts';
import { SESSION_COOKIE, type SessionService } from '../../auth/sessions.ts';
import type { Secret } from '../../config/secret.ts';
import type { Client } from '../../db/schema.ts';
import { ApiError } from '../errors.ts';
import type { AppInstance } from '../types.ts';
import { isInfrastructureRoute } from './openapi.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthOptions {
  client: Client;
  sessions: SessionService;
  sessionSecret: Secret<Buffer>;
  csrfSecret: Secret<Buffer>;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, secure: true, sameSite: 'strict' as const, signed: true, maxAge: maxAgeSeconds };
}

/** Borra la cookie de sesión con los mismos atributos `__Host-` con que se fijó (si no, el navegador no la borra). */
export function clearSessionCookie(reply: FastifyReply, client: Client): void {
  reply.clearCookie(SESSION_COOKIE[client], { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
}

function signedCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.cookies[name];
  if (raw === undefined) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

function isJson(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^application\/json(\s*;.*)?$/i.test(type.trim());
}

function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return (length !== undefined && length !== '0') || request.headers['transfer-encoding'] !== undefined;
}

export async function registerAuth(app: AppInstance, options: AuthOptions): Promise<void> {
  const { client, sessions, csrfSecret } = options;
  const sessionCookie = SESSION_COOKIE[client];
  const anonCookie = ANON_CSRF_COOKIE[client];

  await app.register(cookie, { secret: options.sessionSecret.reveal().toString('base64'), hook: 'onRequest' });
  app.decorateRequest('session', null);

  // Al registrar cada ruta: autenticación declarada, idempotencia sólo con usuario autenticado y los errores de
  // sesión (401) y de CSRF/media type (403/415) documentados en su schema.
  app.addHook('onRoute', (route) => {
    if (isInfrastructureRoute(route)) return;
    const config = route.config as { auth?: unknown; csrf?: unknown; idempotency?: unknown } | undefined;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const where = `${methods.join(',')} ${route.url}`;
    const auth = config?.auth;
    if (auth !== 'public' && auth !== 'account') {
      throw new Error(`ruta sin config.auth ('public' | 'account'): ${where}`);
    }
    if (config?.idempotency === true && auth === 'public') {
      throw new Error(`ruta idempotente sin usuario autenticado: ${where}`);
    }
    const statuses = Object.keys((route.schema as { response?: Record<string, unknown> } | undefined)?.response ?? {});
    const required = [
      ...(auth === 'account' ? ['401'] : []),
      ...(config?.csrf !== false && methods.some((m) => !SAFE_METHODS.has(m)) ? ['403', '415'] : []),
    ];
    const missing = required.filter((status) => !statuses.includes(status));
    if (missing.length > 0) throw new Error(`ruta sin documentar las respuestas ${missing.join(', ')}: ${where}`);
  });

  // preValidation: después del rate limit de la ruta (onRequest) y antes de validar el body (401/403 antes que 400).
  app.addHook('preValidation', async (request, reply) => {
    const token = signedCookie(request, sessionCookie);
    if (token !== null) {
      const session = await sessions.authenticate(token, client);
      if (session) {
        request.session = session;
        request.principal = { userId: session.userId, platformId: session.platformId, sessionId: session.sessionId };
      } else {
        clearSessionCookie(reply, client);
      }
    } else if (request.cookies[sessionCookie] !== undefined) {
      clearSessionCookie(reply, client);
    }

    const config = request.routeOptions.config;
    if (config.auth === 'account' && !request.session) throw new ApiError('UNAUTHENTICATED');

    if (SAFE_METHODS.has(request.method) || config.csrf === false || request.routeOptions.url === undefined) return;
    if (request.headers.origin === undefined) throw new ApiError('CSRF_ORIGIN_REQUIRED');
    const needsJson = request.method !== 'DELETE' || hasBody(request);
    if (needsJson && !isJson(request)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
    const header = request.headers[CSRF_HEADER];
    const binding = csrfBinding(request);
    if (typeof header !== 'string' || binding === null || !csrfTokenMatches(csrfSecret, binding, header)) {
      throw new ApiError('CSRF_TOKEN_INVALID');
    }
  });

  function csrfBinding(request: FastifyRequest): CsrfBinding | null {
    if (request.session) return { kind: 'session', sessionId: request.session.sessionId };
    const anonId = signedCookie(request, anonCookie);
    return anonId === null ? null : { kind: 'anonymous', anonId };
  }

  /** Token CSRF para el request actual; sin sesión crea (o reutiliza) el id anónimo y su cookie. */
  app.decorate('issueCsrfToken', (request: FastifyRequest, reply: FastifyReply): string => {
    if (request.session) return csrfToken(csrfSecret, { kind: 'session', sessionId: request.session.sessionId });
    let anonId = signedCookie(request, anonCookie);
    if (anonId === null) {
      anonId = newAnonId();
      reply.setCookie(anonCookie, anonId, sessionCookieOptions(ANON_CSRF_MAX_AGE_SECONDS));
    }
    return csrfToken(csrfSecret, { kind: 'anonymous', anonId });
  });
}
