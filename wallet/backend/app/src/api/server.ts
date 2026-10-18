// Servidor HTTP (P08.T08): un proceso con dos listeners Fastify independientes — Wallet (8080) y Recovery (8081) —,
// cada uno con su CORS, su spec OpenAPI y sus rutas. El `client` de cada request sale del listener que lo recibió.
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { csrfToken } from '../auth/csrf.ts';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { AppConfig } from '../config/env.ts';
import type { IdempotencyRepository } from '../db/repositories/idempotency-repository.ts';
import type { Client, Database } from '../db/schema.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { registerPlatformSessions } from '../platform-session/plugin.ts';
import type { AccountServices, WalletServices } from '../services.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerErrorHandling } from './plugins/error-handler.ts';
import { registerIdempotency } from './plugins/idempotency.ts';
import { registerOpenApi } from './plugins/openapi.ts';
import { registerRateLimit } from './plugins/rate-limit.ts';
import { registerRequestContext } from './plugins/request-context.ts';
import { registerSecurity } from './plugins/security.ts';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './routes/v1/auth.ts';
import { balanceRoutes } from './routes/v1/balances.ts';
import { transferRoutes } from './routes/v1/transfers.ts';
import { emergencyRoutes } from './routes/v1/emergency.ts';
import { migrationRoutes } from './routes/v1/migration.ts';
import { notificationRoutes } from './routes/v1/notifications.ts';
import { platformSessionsRoutes } from './routes/v1/platform-sessions.ts';
import { operationRoutes } from './routes/v1/operations.ts';
import { recoveryRoutes } from './routes/v1/recovery.ts';
import { rotationRoutes } from './routes/v1/rotations.ts';
import { securityRoutes } from './routes/v1/security.ts';
import { sendRoutes } from './routes/v1/send.ts';
import { sessionsRoutes } from './routes/v1/sessions.ts';
import { swapRoutes } from './routes/v1/swap.ts';
import { usersRoutes } from './routes/v1/users.ts';
import { walletRoutes } from './routes/v1/wallets.ts';
import { whitelistRoutes } from './routes/v1/whitelist.ts';
import type { AppInstance } from './types.ts';

export const API_PREFIX = '/api/v1';

export interface ApiDeps {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  db: Kysely<Database>;
  redis: Redis;
  rpc: RpcQuorumClient;
  idempotency: IdempotencyRepository;
  /** Cuenta y PlatformSession (src/services.ts). */
  services: AccountServices;
  /** Onboarding de wallets (P12); sin ellos los grupos `wallet` y `recovery` no se registran. */
  wallets?: WalletServices;
  version: string;
}

export type ApiInstance = AppInstance;

/** Rutas extra por listener (las fases siguientes registran acá sus grupos; los tests, rutas de prueba). */
export type RouteRegistrar = (app: AppInstance, client: Client) => Promise<void> | void;

export async function buildListener(client: Client, deps: ApiDeps, extraRoutes?: RouteRegistrar): Promise<ApiInstance> {
  const { config } = deps;
  const isWallet = client === 'WALLET';
  const loggerInstance: FastifyBaseLogger = deps.logger.child({ listener: client.toLowerCase() });
  const app = Fastify({
    loggerInstance,
    // Una sola línea por request (request-context.ts) en lugar de las dos de Fastify.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: config.api.bodyLimitBytes,
    // N proxies de confianza → función de proxy-addr (el tipo de Fastify no admite el número directamente).
    trustProxy:
      typeof config.api.trustProxy === 'number'
        ? (
            (hops: number) => (_address: string, hop: number) =>
              hop < hops
          )(config.api.trustProxy)
        : config.api.trustProxy,
    return503OnClosing: true,
    requestTimeout: 30_000,
    connectionTimeout: 35_000,
    routerOptions: { maxParamLength: 200 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Sólo JSON: text/plain es un content-type "simple" que el navegador envía cross-origin sin preflight CORS.
  app.removeContentTypeParser('text/plain');
  registerRequestContext(app, client, deps.metrics);
  registerErrorHandling(app);

  const apiOrigin = new URL(isWallet ? config.api.publicUrlWallet : config.api.publicUrlRecovery).origin;
  await registerSecurity(app, {
    frontendOrigin: isWallet ? config.api.walletOrigin : config.api.recoveryOrigin,
    apiOrigin,
    allowApiOrigin: config.api.docsTryItOut,
  });
  await registerRateLimit(app, {
    client,
    redis: deps.redis,
    globalPerMinute: config.api.rateLimitGlobalPerMinute,
    metrics: deps.metrics,
  });
  registerIdempotency(app, deps.idempotency);
  await registerOpenApi(app, {
    client,
    version: deps.version,
    serverUrl: isWallet ? config.api.publicUrlWallet : config.api.publicUrlRecovery,
    tryItOut: config.api.docsTryItOut,
    appEnv: config.appEnv,
  });
  // Después de OpenAPI: una ruta sin schema se informa primero; Swagger UI (infraestructura) queda sin estos hooks.
  await registerAuth(app, {
    client,
    sessions: deps.services.sessions,
    sessionSecret: config.secrets.sessionSecret,
    csrfSecret: config.secrets.csrfSecret,
  });
  // Después de la autenticación de cuenta: su preValidation corre a continuación de la de cuenta y CSRF.
  registerPlatformSessions(app, { sessions: deps.services.platformSessions, nonces: deps.services.nonces });

  await app.register(healthRoutes, {
    prefix: API_PREFIX,
    version: deps.version,
    readiness: { db: deps.db, redis: deps.redis, rpc: deps.rpc },
  });
  const csrfForSession = (sessionId: string) => csrfToken(config.secrets.csrfSecret, { kind: 'session', sessionId });
  const { account } = deps.services;
  await app.register(authRoutes, { prefix: API_PREFIX, account, csrfForSession });
  await app.register(sessionsRoutes, { prefix: API_PREFIX, account });
  await app.register(usersRoutes, { prefix: API_PREFIX, account });
  await app.register(notificationRoutes, { prefix: API_PREFIX, notifications: deps.services.notifications });
  // P16.T04: reportes de seguridad de las dos apps (CSP/Trusted Types y service workers), públicos y con rate limit.
  await app.register(securityRoutes, { prefix: API_PREFIX, metrics: deps.metrics });
  await app.register(platformSessionsRoutes, {
    prefix: API_PREFIX,
    client,
    db: deps.db,
    audit: deps.services.audit,
    platformSessions: deps.services.platformSessions,
    stepUp: deps.services.stepUp,
    // El desbloqueo con U (OPAQUE) existe sólo en el listener de Wallet ([B-API]).
    unlock: isWallet ? deps.services.unlock : null,
    csrfForSession,
  });
  if (deps.wallets) {
    // [B-AUTHZ] 3: el grupo `wallet` existe sólo en el listener de Wallet; `recovery` reparte sus rutas por listener.
    if (isWallet) {
      await app.register(walletRoutes, {
        prefix: API_PREFIX,
        wallets: deps.wallets.wallets,
        keyRestore: deps.wallets.keyRestore,
      });
    }
    await app.register(recoveryRoutes, {
      prefix: API_PREFIX,
      client,
      enrollments: deps.wallets.enrollments,
      uReplacement: deps.wallets.uReplacement,
    });
    // Operaciones (P13): en Wallet firma U (OPERATIONS) y en Recovery firma R (RECOVERY); el 2FA de alto valor (P14)
    // sólo en Wallet.
    await app.register(operationRoutes, {
      prefix: API_PREFIX,
      client,
      operations: deps.wallets.operations,
      ...(isWallet ? { twoFactor: deps.wallets.twoFactor } : {}),
    });
    // P14: whitelist (lectura en los dos; alta y baja con U sólo en Wallet), send, swap y saldos en Wallet, y el grupo
    // de emergencia (R) en Recovery.
    await app.register(whitelistRoutes, { prefix: API_PREFIX, client, whitelist: deps.wallets.whitelist });
    // P15: rotaciones en los dos listeners (U propone/ejecuta en Wallet, R en Recovery) y relay público de cancelación.
    await app.register(rotationRoutes, { prefix: API_PREFIX, client, rotations: deps.wallets.rotations });
    await app.register(migrationRoutes, { prefix: API_PREFIX, client, migrations: deps.wallets.migrations });
    if (isWallet) {
      await app.register(sendRoutes, { prefix: API_PREFIX, send: deps.wallets.send });
      await app.register(swapRoutes, { prefix: API_PREFIX, swaps: deps.wallets.swaps });
      await app.register(balanceRoutes, { prefix: API_PREFIX, balances: deps.wallets.balances });
      await app.register(transferRoutes, { prefix: API_PREFIX, transfers: deps.wallets.transfers });
    } else {
      await app.register(emergencyRoutes, {
        prefix: API_PREFIX,
        operations: deps.wallets.operations,
        whitelist: deps.wallets.whitelist,
        swaps: deps.wallets.swaps,
      });
    }
  }
  if (extraRoutes) {
    await app.register(
      async (scope) => {
        await extraRoutes(scope, client);
      },
      { prefix: API_PREFIX },
    );
  }
  await app.ready();
  return app;
}

export interface RunningApi {
  wallet: ApiInstance;
  recovery: ApiInstance;
  close: () => Promise<void>;
}

export async function startApi(deps: ApiDeps, extraRoutes?: RouteRegistrar): Promise<RunningApi> {
  const wallet = await buildListener('WALLET', deps, extraRoutes);
  const recovery = await buildListener('RECOVERY', deps, extraRoutes);
  const host = deps.config.api.bindHost;
  await wallet.listen({ host, port: deps.config.api.walletPort });
  await recovery.listen({ host, port: deps.config.api.recoveryPort });
  return {
    wallet,
    recovery,
    close: async () => {
      await Promise.all([wallet.close(), recovery.close()]);
    },
  };
}
