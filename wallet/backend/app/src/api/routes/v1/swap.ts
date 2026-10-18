// Grupo `swap` de [B-API] (P14.T04/T05/T06), sólo en el listener de Wallet: cotización (sesión de cuenta), prepare del
// par approve/swap (crítico), lectura del grupo y, si el swap falló con allowance residual, re-cotización (par nuevo)
// o revocación de la allowance (críticos).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OPERATION_GROUP_STATUSES } from '../../../operations/groups.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { SwapService } from '../../../swap/prepare.ts';
import { errorResponses } from '../../errors.ts';
import { OperationStatusSchema, operationActor, PreparedOperationSchema } from './operations.ts';
import { TokenAmountSchema } from './send.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];
const Token = z.enum(['USDC', 'USDT']);
const Slippage = z.coerce
  .number()
  .int()
  .min(0)
  .max(50)
  .optional()
  .describe('Slippage en bps sobre la cotización (default 30, máximo 50 = piso on-chain)');

export const SwapQuoteSchema = z
  .object({
    tokenIn: Token,
    tokenOut: Token,
    amountIn: z.string(),
    expectedOut: z.string().describe('Salida de QuoterV2 en el bloque de la cotización'),
    minOut: z.string().describe('expectedOut · (1 − slippage), nunca debajo del piso on-chain (amountIn · 0,995)'),
    slippageBps: z.number().int(),
    priceImpactBps: z.number().int().describe('Contra el precio medio del pool antes del swap'),
    deadline: z.string().describe('Segundos Unix: bloque de la cotización + 10 min'),
    blockNumber: z.string(),
    quotedAt: z.iso.datetime(),
    pool: z.string(),
    fee: z.number().int(),
  })
  .meta({ id: 'SwapQuote' });

export const OperationGroupSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    type: z.literal('SWAP'),
    status: z.enum(OPERATION_GROUP_STATUSES),
    tokenIn: Token,
    tokenOut: Token,
    amountIn: z.string(),
    quote: z.object({
      expectedOut: z.string(),
      minOut: z.string(),
      slippageBps: z.number().int(),
      priceImpactBps: z.number().int(),
      deadline: z.string(),
      blockNumber: z.string(),
      quotedAt: z.iso.datetime(),
    }),
    failureReason: z.string().nullable(),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    nextActions: z
      .array(z.enum(['REQUOTE', 'REVOKE_APPROVAL']))
      .describe('Con el swap fallido y allowance residual: volver a cotizar o revocar la allowance'),
    operations: z.array(OperationStatusSchema),
  })
  .meta({ id: 'OperationGroup' });

const PreparedSwapSchema = z
  .object({ group: OperationGroupSchema, quote: SwapQuoteSchema, operations: z.array(PreparedOperationSchema) })
  .meta({ id: 'PreparedSwap', description: 'Par approve (nonce N) + swap (N+1) para firmar juntos con U' });

export interface SwapRoutesOptions {
  swaps: SwapService;
}

export const swapRoutes: FastifyPluginCallbackZod<SwapRoutesOptions> = (app, options, done) => {
  const tags = ['swap'];
  const { swaps } = options;

  app.get(
    '/wallets/:id/swap/quote',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'quoteSwap',
        tags,
        summary: 'Cotización USDC↔USDT con QuoterV2 sobre el pool canónico (lectura con quórum)',
        security: accountSecurity,
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ tokenIn: Token, amountIn: TokenAmountSchema, slippageBps: Slippage }),
        response: { 200: SwapQuoteSchema, ...errorResponses(401, 404, 409, 422) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return swaps.quote(session.userId, request.params.id, {
        tokenIn: request.query.tokenIn,
        amountIn: BigInt(request.query.amountIn),
        slippageBps: request.query.slippageBps,
      });
    },
  );

  app.post(
    '/wallets/:id/swap/prepare',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'prepareSwap',
        tags,
        summary: 'Cotiza y prepara el par approve exacto (nonce N) + swap (N+1) para firmar juntos con U',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: z.object({ id: z.uuid() }),
        body: z.object({ tokenIn: Token, amountIn: TokenAmountSchema, slippageBps: Slippage }).strict(),
        response: { 200: PreparedSwapSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
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
      return swaps.prepare(actor, request.params.id, {
        tokenIn: request.body.tokenIn,
        amountIn: BigInt(request.body.amountIn),
        slippageBps: request.body.slippageBps,
      });
    },
  );

  app.get(
    '/operation-groups/:id',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getOperationGroup',
        tags,
        summary: 'Grupo de un swap: estado, cotización vigente, operaciones y acciones ofrecidas',
        security: accountSecurity,
        params: z.object({ id: z.uuid() }),
        response: { 200: OperationGroupSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return swaps.group(session.userId, request.params.id);
    },
  );

  app.post(
    '/operation-groups/:id/requote',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'requoteSwap',
        tags,
        summary:
          'Swap fallido con allowance residual: cotización nueva y par nuevo approve + swap (mismo token y monto)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: z.object({ id: z.uuid() }),
        body: z.object({ slippageBps: Slippage }).strict(),
        response: { 200: PreparedSwapSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
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
      return swaps.requote(actor, request.params.id, { slippageBps: request.body.slippageBps });
    },
  );

  app.post(
    '/operation-groups/:id/revoke-approval',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'revokeSwapApproval',
        tags,
        summary: 'Swap fallido con allowance residual: prepara approve(SwapExecutor, 0) para firmar con U',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: z.object({ id: z.uuid() }),
        body: z.object({}).strict(),
        response: { 200: PreparedOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return swaps.revokeApproval(actor, request.params.id);
    },
  );

  done();
};
