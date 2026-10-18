// Headers de seguridad (helmet) y CORS estricto por listener (P08.T08): cada listener acepta sólo el origin de su
// frontend, con credenciales. Un request con un Origin distinto se rechaza en el servidor (403 ORIGIN_NOT_ALLOWED),
// también en el preflight; los requests sin Origin (curl, servidor a servidor) no son CORS y siguen.
// En local/staging también se acepta el origin del propio API, para "Try it out" de Swagger desde /docs (§7.11).
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ApiError } from '../errors.ts';
import type { AppInstance } from '../types.ts';

export interface SecurityOptions {
  frontendOrigin: string;
  apiOrigin: string;
  allowApiOrigin: boolean;
}

/**
 * Headers que el navegador puede mandar en un request CORS: además del CSRF y la idempotencia, todos los de un request
 * crítico firmado ([B-PSES-05]: token, timestamp, nonce y firma). Sin uno de ellos el preflight falla y el request
 * nunca sale del navegador.
 */
export const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'X-CSRF-Token',
  'X-Platform-Session',
  'X-Session-Timestamp',
  'X-Session-Nonce',
  'X-Session-Signature',
  'Idempotency-Key',
];

export const EXPOSED_RESPONSE_HEADERS = [
  'X-Request-Id',
  'Retry-After',
  'Idempotent-Replayed',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

export async function registerSecurity(app: AppInstance, options: SecurityOptions): Promise<void> {
  const allowed = new Set([options.frontendOrigin, ...(options.allowApiOrigin ? [options.apiOrigin] : [])]);

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (origin === undefined) {
        callback(null, false);
        return;
      }
      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new ApiError('ORIGIN_NOT_ALLOWED'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    maxAge: 600,
    strictPreflight: true,
  });
}
