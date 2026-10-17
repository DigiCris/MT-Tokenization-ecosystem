// Extensiones de tipos de Fastify compartidas por los plugins de la API.
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
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
    idempotency: { userId: string; key: string } | null;
  }

  interface FastifyContextConfig {
    /** POST que crea recursos u operaciones: exige Idempotency-Key ([B-API]). */
    idempotency?: boolean;
  }

  interface FastifyInstance {
    /** Rutas de la API registradas en el listener (sin /docs ni preflight), todas con schema completo. */
    apiRoutes: readonly { method: string; url: string }[];
    /** Consume los buckets de una política de [B-RL]; lanza RATE_LIMITED si alguno se excede. */
    enforceRateLimit: (request: FastifyRequest, policy: RateLimitPolicyName, keys: RateLimitKeys) => Promise<void>;
  }
}
