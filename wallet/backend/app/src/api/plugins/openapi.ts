// OpenAPI 3.1 generado desde los schemas Zod de cada ruta y Swagger UI en /docs (P08.T09, §7.11).
//
// - Cada listener publica sólo sus rutas (`/docs` y `/docs/openapi.json` en ambos).
// - local/staging: "Try it out" habilitado (mismo origin que el API, con credenciales); producción: sólo la spec.
// - Ninguna ruta sin schema: al registrarse, toda ruta pública debe declarar operationId, tags, respuesta 2xx y las
//   respuestas de error estándar; si falta algo, el servidor no arranca.
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { RouteOptions } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { Client } from '../../db/schema.ts';
import type { AppInstance } from '../types.ts';

export const DOCS_PREFIX = '/docs';
export const REQUIRED_ERROR_STATUSES = [400, 429, 500, 503] as const;

export interface OpenApiOptions {
  client: Client;
  version: string;
  serverUrl: string;
  tryItOut: boolean;
  appEnv: string;
}

/** Rutas que no forman parte de la API documentada: Swagger UI, su spec y los preflight CORS. */
export function isInfrastructureRoute(route: Pick<RouteOptions, 'url' | 'method' | 'schema'>): boolean {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  return (
    route.url === DOCS_PREFIX ||
    route.url.startsWith(`${DOCS_PREFIX}/`) ||
    methods.every((m) => m === 'OPTIONS' || m === 'HEAD') ||
    (route.schema as { hide?: boolean } | undefined)?.hide === true
  );
}

/** Problemas de documentación de una ruta (vacío = completa). */
export function routeSchemaProblems(route: Pick<RouteOptions, 'url' | 'method' | 'schema'>): string[] {
  if (isInfrastructureRoute(route)) return [];
  const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== 'HEAD');
  const schema = route.schema as
    | { operationId?: unknown; tags?: unknown; summary?: unknown; response?: Record<string, unknown>; body?: unknown }
    | undefined;
  const where = `${methods.join(',')} ${route.url}`;
  if (!schema) return [`${where}: sin schema`];
  const problems: string[] = [];
  if (typeof schema.operationId !== 'string') problems.push(`${where}: falta operationId`);
  if (!Array.isArray(schema.tags) || schema.tags.length === 0) problems.push(`${where}: faltan tags`);
  if (typeof schema.summary !== 'string') problems.push(`${where}: falta summary`);
  const statuses = Object.keys(schema.response ?? {});
  if (!statuses.some((s) => /^2\d\d$/.test(s))) problems.push(`${where}: falta la respuesta 2xx`);
  for (const status of REQUIRED_ERROR_STATUSES) {
    if (!statuses.includes(String(status))) problems.push(`${where}: falta la respuesta de error ${status}`);
  }
  if (methods.some((m) => m === 'POST' || m === 'PATCH' || m === 'PUT') && schema.body === undefined) {
    problems.push(`${where}: falta el schema del body`);
  }
  return problems;
}

export async function registerOpenApi(app: AppInstance, options: OpenApiOptions): Promise<void> {
  const routes: { method: string; url: string }[] = [];
  app.decorate('apiRoutes', routes);
  app.addHook('onRoute', (route) => {
    const problems = routeSchemaProblems(route);
    if (problems.length > 0) throw new Error(`ruta sin schema completo: ${problems.join('; ')}`);
    if (isInfrastructureRoute(route)) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== 'HEAD') routes.push({ method, url: route.url });
    }
  });

  const title = options.client === 'WALLET' ? 'MTW API — Wallet' : 'MTW API — Recovery';
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title,
        version: options.version,
        description:
          options.client === 'WALLET'
            ? 'API del listener de Wallet (`api.<WALLET_DOMAIN>`). Errores RFC 9457 (`application/problem+json`).'
            : 'API del listener de Recovery (`api.<RECOVERY_DOMAIN>`). Errores RFC 9457 (`application/problem+json`).',
      },
      servers: [{ url: options.serverUrl }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: options.client === 'WALLET' ? '__Host-mtw_sid' : '__Host-mtr_sid',
            description: 'Sesión de cuenta (cookie HttpOnly del API host; la fija el login).',
          },
          csrfToken: {
            type: 'apiKey',
            in: 'header',
            name: 'X-CSRF-Token',
            description: 'Token de GET /api/v1/auth/csrf; obligatorio en todo método no-GET.',
          },
          platformSession: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Platform-Session',
            description: 'PlatformSession (JWS EdDSA de 15 min) del desbloqueo OPAQUE o del step-up.',
          },
          sessionSignature: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Session-Signature',
            description:
              'Firma P-256 (IEEE P1363, base64url) de MTW-REQ-V1\\n{método}\\n{ruta}\\n{sha256 del body}\\n{timestamp}\\n{nonce}\\n{sessionId}, ' +
              'con X-Session-Timestamp (segundos Unix, ±60 s) y X-Session-Nonce (16 bytes hex, un solo uso). En local, ' +
              '`pnpm dev:session` emite los headers de un request.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(swaggerUi, {
    routePrefix: DOCS_PREFIX,
    staticCSP: true,
    // En http://localhost, upgrade-insecure-requests haría pedir los assets por https.
    transformStaticCSP: (header) =>
      options.appEnv === 'local' ? header.replace(/\s*upgrade-insecure-requests;?/g, '') : header,
    uiConfig: {
      // Sin la barra "Explore": la UI sólo muestra la spec de su propio listener (no carga URLs arbitrarias).
      layout: 'BaseLayout',
      deepLinking: false,
      tryItOutEnabled: false,
      supportedSubmitMethods: options.tryItOut ? ['get', 'post', 'patch', 'delete'] : [],
      withCredentials: options.tryItOut,
    },
  });

  app.get(`${DOCS_PREFIX}/openapi.json`, { schema: { hide: true } }, (_request, reply) => reply.send(app.swagger()));
}
