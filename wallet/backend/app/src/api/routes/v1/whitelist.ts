// Grupo `whitelist` de [B-API] (P14.T01/T06): pedido de alta con challenge por email, confirmación con el código
// (devuelve la SafeTx `addDestination` para firmar con U), baja (`removeDestination`) y lectura. Las escrituras son
// críticas (PlatformSession OPERATIONS + firma del request) e idempotentes y existen sólo en el listener de Wallet; la
// lectura usa la sesión de cuenta y está en los dos listeners (Recovery la muestra para la baja de emergencia con R).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Client } from '../../../db/schema.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { WhitelistService } from '../../../whitelist/service.ts';
import { errorResponses } from '../../errors.ts';
import { requestMeta } from './auth.ts';
import { operationActor, PreparedOperationSchema } from './operations.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

/** Código del email (8 dígitos). */
const EmailCode = z.string().regex(/^\d{8}$/, { error: 'el código tiene 8 dígitos' });

/** Etiqueta visible: sin caracteres de control ni de formato (p. ej. overrides bidi que disfrazan una dirección). */
export const LabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, { error: 'la etiqueta no admite caracteres de control ni de formato' });

export const WhitelistRequestSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    destination: Address,
    label: z.string(),
    status: z.enum([
      'PENDING_CHALLENGE',
      'CHALLENGE_PASSED',
      'AWAITING_SIGNATURE',
      'SUBMITTED',
      'ACTIVATING',
      'ACTIVE',
      'EXPIRED',
      'CANCELLED',
      'FAILED',
    ]),
    challengeExpiresAt: z.iso.datetime().nullable().describe('Vencimiento del código (sólo mientras se espera)'),
    operationId: z.uuid().nullable().describe('SafeTx addDestination preparada al confirmar'),
    failureReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WhitelistRequest' });

export const WhitelistEntrySchema = z
  .object({
    id: z.uuid(),
    destination: Address,
    label: z.string(),
    status: z.enum(['ACTIVATING', 'ACTIVE', 'REMOVED']),
    activatesAt: z.iso.datetime().describe('Desde cuándo vale on-chain (24 h después del alta)'),
    activatedAt: z.iso.datetime().nullable(),
    origin: z.enum(['PLATFORM', 'SOVEREIGN']).describe('SOVEREIGN: agregado con U+R por fuera de la plataforma'),
    addedTxHash: Hex32.nullable(),
  })
  .meta({ id: 'WhitelistEntry' });

export interface WhitelistRoutesOptions {
  client: Client;
  whitelist: WhitelistService;
}

const WalletIdParams = z.object({ id: z.uuid() });

export const whitelistRoutes: FastifyPluginCallbackZod<WhitelistRoutesOptions> = (app, options, done) => {
  const tags = ['whitelist'];
  const { whitelist } = options;

  app.get(
    '/wallets/:id/whitelist',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getWhitelist',
        tags,
        summary: 'Destinos autorizados (activos y en activación) y pedidos de alta abiertos',
        security: accountSecurity,
        params: WalletIdParams,
        response: {
          200: z.object({ entries: z.array(WhitelistEntrySchema), requests: z.array(WhitelistRequestSchema) }),
          ...errorResponses(401, 404),
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return whitelist.list(session.userId, request.params.id);
    },
  );

  // [B-AUTHZ] 3: el listener de Recovery no expone el alta (ni la baja con U: la de R es el grupo de emergencia).
  if (options.client === 'WALLET') {
    app.post(
      '/wallets/:id/whitelist/requests',
      {
        config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
        schema: {
          operationId: 'requestWhitelistDestination',
          tags,
          summary:
            'Pide el alta de un destino: envía por email un código ligado a la Safe, la red, el destino y la expiración',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: WalletIdParams,
          body: z
            .object({
              destination: z.string().min(1).max(100).describe('Dirección EVM (checksum EIP-55 o toda en minúsculas)'),
              label: LabelSchema,
            })
            .strict(),
          response: { 201: WhitelistRequestSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
        },
      },
      async (request, reply) => {
        const actor = operationActor(request);
        await app.enforceRateLimit(request, 'whitelist-request', {
          user: actor.userId,
          safe: actor.session.claims.safe ?? request.params.id,
        });
        await app.enforceRateLimit(request, 'otp-challenge', { user: actor.userId, challengeType: 'WHITELIST_ADD' });
        const created = await whitelist.request(actor, request.params.id, request.body, {
          userAgent: requestMeta(request).userAgent,
        });
        return reply.code(201).send(created);
      },
    );

    app.post(
      '/whitelist/requests/:id/confirm',
      {
        config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
        schema: {
          operationId: 'confirmWhitelistRequest',
          tags,
          summary:
            'Confirma el alta con el código del email y devuelve la SafeTx addDestination para firmar con U (con la atestación del challenge)',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: z.object({ id: z.uuid() }),
          body: z.object({ code: EmailCode }).strict(),
          response: {
            200: z.object({ request: WhitelistRequestSchema, operation: PreparedOperationSchema }),
            ...errorResponses(401, 403, 404, 409, 415, 422),
          },
        },
      },
      async (request) => {
        const actor = operationActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return whitelist.confirm(actor, request.params.id, request.body.code);
      },
    );

    app.post(
      '/wallets/:id/whitelist/:destination/remove',
      {
        config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
        schema: {
          operationId: 'removeWhitelistDestination',
          tags,
          summary: 'Prepara la baja inmediata de un destino (SafeTx removeDestination para firmar con U)',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: z.object({ id: z.uuid(), destination: z.string().min(1).max(100) }),
          body: z.object({}).strict(),
          response: { 200: PreparedOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
        },
      },
      async (request) => {
        const actor = operationActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return whitelist.remove(actor, request.params.id, request.params.destination);
      },
    );
  }

  done();
};
