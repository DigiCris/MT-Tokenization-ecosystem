// Grupo `emergencia (R)` de [B-API] (P14; las pantallas son P19.T10), sólo en el listener de Recovery y con scope
// RECOVERY: con R + S, quitar un destino de la whitelist (baja inmediata), cancelar una operación pendiente con una
// NoOp del mismo nonce y revocar la allowance de un token hacia el SwapExecutor — el botón de pánico si U está
// comprometida. Todas son críticas e idempotentes y devuelven la SafeTx para firmar con R.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OperationService } from '../../../operations/service.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { SwapService } from '../../../swap/prepare.ts';
import type { WhitelistService } from '../../../whitelist/service.ts';
import { ApiError, errorResponses } from '../../errors.ts';
import { OperationStatusSchema, operationActor, PreparedOperationSchema } from './operations.ts';

const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];

export interface EmergencyRoutesOptions {
  operations: OperationService;
  whitelist: WhitelistService;
  swaps: SwapService;
}

const WalletIdParams = z.object({ id: z.uuid() });

export const emergencyRoutes: FastifyPluginCallbackZod<EmergencyRoutesOptions> = (app, options, done) => {
  const tags = ['emergency'];
  const config = {
    auth: 'account',
    idempotency: true,
    platformSession: { scopes: ['RECOVERY'], critical: true },
  } as const;

  app.post(
    '/wallets/:id/emergency/whitelist-remove',
    {
      config,
      schema: {
        operationId: 'emergencyWhitelistRemove',
        tags,
        summary: 'Prepara con R la baja inmediata de un destino de la whitelist (SafeTx removeDestination)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({ destination: z.string().min(1).max(100) }).strict(),
        response: { 200: PreparedOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return options.whitelist.remove(actor, request.params.id, request.body.destination);
    },
  );

  app.post(
    '/wallets/:id/emergency/noop',
    {
      config,
      schema: {
        operationId: 'emergencyNoop',
        tags,
        summary: 'Cancela con R una operación pendiente: NoOp con el mismo nonce para firmar con R',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({ operationId: z.uuid() }).strict(),
        response: {
          200: z.object({ operation: OperationStatusSchema, noop: PreparedOperationSchema.nullable() }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      const operation = await options.operations.get(actor.userId, request.body.operationId);
      if (operation.walletId !== request.params.id) throw new ApiError('NOT_FOUND');
      return options.operations.cancel(actor, request.body.operationId);
    },
  );

  app.post(
    '/wallets/:id/emergency/revoke-approval',
    {
      config,
      schema: {
        operationId: 'emergencyRevokeApproval',
        tags,
        summary: 'Prepara con R approve(SwapExecutor, 0) de USDC o USDT (revoca una allowance residual)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({ token: z.enum(['USDC', 'USDT']) }).strict(),
        response: { 200: PreparedOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return options.swaps.revokeToken(actor, request.params.id, request.body.token);
    },
  );

  done();
};
