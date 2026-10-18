// Grupo `balances` de [B-API] (P14.T06): GET /wallets/{id}/balances con la sesión de cuenta (lectura con quórum; el
// frontend además lee directo de su propio RPC).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BalanceService } from '../../../wallets/balances.ts';
import { errorResponses } from '../../errors.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];

export const BalancesSchema = z
  .object({
    walletId: z.uuid(),
    safe: z.string(),
    chainId: z.number().int(),
    blockNumber: z.string().describe('Bloque común de la lectura con quórum'),
    tokens: z.array(
      z.object({
        symbol: z.enum(['USDC', 'USDT']),
        address: z.string(),
        decimals: z.literal(6),
        balance: z.string(),
        allowanceToSwapExecutor: z
          .string()
          .describe('Allowance hacia el SwapExecutor (debería ser 0 fuera de un swap)'),
      }),
    ),
  })
  .meta({ id: 'Balances' });

export interface BalanceRoutesOptions {
  balances: BalanceService;
}

export const balanceRoutes: FastifyPluginCallbackZod<BalanceRoutesOptions> = (app, options, done) => {
  app.get(
    '/wallets/:id/balances',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getBalances',
        tags: ['balances'],
        summary: 'Saldos de USDC y USDT de la Safe (lectura con quórum de los dos RPC)',
        security: accountSecurity,
        params: z.object({ id: z.uuid() }),
        response: { 200: BalancesSchema, ...errorResponses(401, 404, 409) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return options.balances.balances(session.userId, request.params.id);
    },
  );

  done();
};
