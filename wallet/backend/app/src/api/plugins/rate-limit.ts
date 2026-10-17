// Rate limiting [B-RL] con store en Valkey (compartido por todas las instancias de la API).
//
// - Límite global por IP y listener (Swagger/API: 300/min en staging/producción, 1.000/min en local).
// - Políticas por acción: cada una con uno o más buckets (ventana fija) por IP, usuario, sesión, Safe, email,
//   propuesta o tipo de challenge. Las rutas llaman a `app.enforceRateLimit(request, política, claves)`. Cada política
//   usa sus propias claves en Valkey: ningún bucket se comparte entre políticas (p. ej. el relay de cancelación), y
//   sí entre listeners (los dos API hosts comparten los contadores de una misma cuenta).
// - Los valores de las claves se guardan hasheados (sin emails ni IPs en claro en Valkey).
// - Fail-closed: si Valkey no responde, el request falla (503) en lugar de saltear el límite.
import { createHash } from 'node:crypto';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Client } from '../../db/schema.ts';
import type { Metrics } from '../../observability/metrics.ts';
import { ApiError } from '../errors.ts';
import type { AppInstance } from '../types.ts';

export type RateLimitKeyKind = 'ip' | 'user' | 'session' | 'safe' | 'email' | 'proposal' | 'challengeType';
export type RateLimitKeys = Partial<Record<Exclude<RateLimitKeyKind, 'ip'>, string>>;

interface Bucket {
  name: string;
  max: number;
  windowMs: number;
  keys: readonly RateLimitKeyKind[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Tabla [B-RL] (§7.11). Los intentos por challenge (5) los limita la propia fila del challenge en Postgres. */
export const RATE_LIMIT_POLICIES = {
  login: [
    { name: 'ip-email', max: 5, windowMs: MINUTE, keys: ['ip', 'email'] },
    { name: 'email', max: 20, windowMs: HOUR, keys: ['email'] },
    { name: 'ip', max: 100, windowMs: HOUR, keys: ['ip'] },
  ],
  'forgot-password': [
    { name: 'email', max: 3, windowMs: HOUR, keys: ['email'] },
    { name: 'ip', max: 10, windowMs: HOUR, keys: ['ip'] },
  ],
  'otp-challenge': [{ name: 'user-type', max: 3, windowMs: 10 * MINUTE, keys: ['user', 'challengeType'] }],
  'whitelist-request': [
    { name: 'safe', max: 5, windowMs: DAY, keys: ['safe'] },
    { name: 'user', max: 10, windowMs: DAY, keys: ['user'] },
  ],
  'send-swap-prepare': [
    { name: 'session', max: 10, windowMs: MINUTE, keys: ['session'] },
    { name: 'user', max: 30, windowMs: HOUR, keys: ['user'] },
    { name: 'safe', max: 60, windowMs: HOUR, keys: ['safe'] },
  ],
  'operation-create': [{ name: 'user', max: 60, windowMs: HOUR, keys: ['user'] }],
  'step-up-onboarding': [
    { name: 'user', max: 10, windowMs: DAY, keys: ['user'] },
    { name: 'ip', max: 30, windowMs: DAY, keys: ['ip'] },
  ],
  'recovery-sensitive': [
    { name: 'user', max: 3, windowMs: DAY, keys: ['user'] },
    { name: 'ip', max: 10, windowMs: DAY, keys: ['ip'] },
  ],
  'rotation-cancel-relay': [
    { name: 'proposal', max: 10, windowMs: HOUR, keys: ['proposal'] },
    { name: 'ip', max: 60, windowMs: HOUR, keys: ['ip'] },
  ],
} as const satisfies Record<string, readonly Bucket[]>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export const RATE_LIMIT_NAMESPACE = 'mtw:rl:';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function ipKey(request: FastifyRequest): string {
  return normalizeIP(request.ip, 64);
}

function retryAfterSeconds(ttlMs: number): string {
  return String(Math.max(1, Math.ceil(ttlMs / 1000)));
}

export interface RateLimitOptions {
  client: Client;
  redis: Redis;
  globalPerMinute: number;
  metrics: Metrics;
}

export async function registerRateLimit(app: AppInstance, options: RateLimitOptions): Promise<void> {
  const { client, metrics } = options;
  await app.register(rateLimit, {
    global: true,
    max: options.globalPerMinute,
    timeWindow: MINUTE,
    redis: options.redis,
    nameSpace: RATE_LIMIT_NAMESPACE,
    skipOnError: false,
    keyGenerator: (request) => `global:${client}:${digest(ipKey(request))}`,
    onExceeded: () => {
      metrics.rateLimitHits.inc({ listener: client, policy: 'global' });
    },
    errorResponseBuilder: (_request, context) =>
      new ApiError('RATE_LIMITED', { headers: { 'retry-after': retryAfterSeconds(context.ttl) } }),
  });

  app.decorate(
    'enforceRateLimit',
    async (request: FastifyRequest, policy: RateLimitPolicyName, keys: RateLimitKeys) => {
      const buckets: readonly Bucket[] = RATE_LIMIT_POLICIES[policy];
      let exceeded = false;
      let retryAfterMs = 0;
      for (const bucket of buckets) {
        const parts = bucket.keys.map((kind) => {
          const value = kind === 'ip' ? ipKey(request) : keys[kind];
          if (value === undefined || value === '') {
            throw new Error(`rate limit ${policy}/${bucket.name}: falta la clave ${kind}`);
          }
          return `${kind}=${digest(value)}`;
        });
        // Sin el listener en la clave: alternar entre los API hosts de Wallet y Recovery no duplica los intentos.
        const key = `policy:${policy}:${bucket.name}:${parts.join(':')}`;
        const limit = await app.createRateLimit({
          max: bucket.max,
          timeWindow: bucket.windowMs,
          keyGenerator: () => key,
        })(request);
        if (!limit.isAllowed && limit.isExceeded) {
          exceeded = true;
          retryAfterMs = Math.max(retryAfterMs, limit.ttl);
        }
      }
      if (exceeded) {
        metrics.rateLimitHits.inc({ listener: client, policy });
        throw new ApiError('RATE_LIMITED', { headers: { 'retry-after': retryAfterSeconds(retryAfterMs) } });
      }
    },
  );
}
