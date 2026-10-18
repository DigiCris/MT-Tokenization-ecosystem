// Grupo `send` de [B-API] (P14.T03): POST /wallets/{id}/send/prepare (crítico, idempotente, sólo en el listener de
// Wallet). El monto va en unidades del token (6 decimales); el backend arma la SafeTx `transfer` y la evalúa con la
// policy y las lecturas on-chain con quórum; sobre el umbral la operación vuelve con `requiresTwoFactor`.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { SendService } from '../../../send/service.ts';
import { errorResponses } from '../../errors.ts';
import { operationActor, PreparedOperationSchema } from './operations.ts';

const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];

/** Monto en unidades mínimas (entero positivo en decimal, sin ceros a la izquierda). */
export const TokenAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,30}$/, { error: 'monto entero positivo en unidades del token (6 decimales)' });

export interface SendRoutesOptions {
  send: SendService;
}

export const sendRoutes: FastifyPluginCallbackZod<SendRoutesOptions> = (app, options, done) => {
  app.post(
    '/wallets/:id/send/prepare',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'prepareSend',
        tags: ['send'],
        summary:
          'Prepara un envío de USDC o USDT a un destino activo de la whitelist (SafeTx transfer para firmar con U)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            token: z.enum(['USDC', 'USDT']),
            destination: z.string().min(1).max(100),
            amount: TokenAmountSchema,
          })
          .strict(),
        response: { 200: PreparedOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'send-swap-prepare', {
        session: actor.session.claims.sessionId,
        user: actor.userId,
        safe: actor.session.claims.safe ?? request.params.id,
      });
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return options.send.prepare(actor, request.params.id, {
        token: request.body.token,
        destination: request.body.destination,
        amount: BigInt(request.body.amount),
      });
    },
  );

  done();
};
