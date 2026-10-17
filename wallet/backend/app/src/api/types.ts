// Extensiones de tipos de Fastify compartidas por los plugins de la API.
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AuthenticatedSession } from '../auth/sessions.ts';
import type { Client } from '../db/schema.ts';
import type { RateLimitKeys, RateLimitPolicyName } from './plugins/rate-limit.ts';

/** Instancia de Fastify de cada listener (schemas Zod como type provider). */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Usuario autenticado por la sesión de cuenta (lo completa la autenticación de P09). */
export interface Principal {
  userId: string;
  platformId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Cliente derivado del listener que recibió el request (nunca de un header). */
    client: Client;
    principal: Principal | null;
    /** Sesión de cuenta vigente (cookie del listener), o null. */
    session: AuthenticatedSession | null;
    idempotency: { userId: string; key: string } | null;
  }

  interface FastifyContextConfig {
    /** POST que crea recursos u operaciones: exige Idempotency-Key ([B-API]). */
    idempotency?: boolean;
    /** Obligatorio en toda ruta de la API: pública o con sesión de cuenta (si falta, el servidor no arranca). */
    auth?: 'public' | 'account';
    /** false sólo en rutas sin cookies cuyo propio mecanismo reemplaza al CSRF (relay firmado, reportes CSP). */
    csrf?: boolean;
  }

  interface FastifyInstance {
    /** Token CSRF para el request (atado a la sesión o, sin sesión, al id anónimo de su cookie). */
    issueCsrfToken: (request: FastifyRequest, reply: FastifyReply) => string;
    /** Rutas de la API registradas en el listener (sin /docs ni preflight), todas con schema completo. */
    apiRoutes: readonly { method: string; url: string }[];
    /** Consume los buckets de una política de [B-RL]; lanza RATE_LIMITED si alguno se excede. */
    enforceRateLimit: (request: FastifyRequest, policy: RateLimitPolicyName, keys: RateLimitKeys) => Promise<void>;
  }
}
