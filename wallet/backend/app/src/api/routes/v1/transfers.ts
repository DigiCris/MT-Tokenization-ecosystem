// Grupo `balances` de [B-API], actividad (P18.T08): GET /wallets/{id}/transfers con la sesión de cuenta, los transfers
// de USDC y USDT desde y hacia la Safe que indexa el indexer (también los que no originó la plataforma).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TransferService } from '../../../wallets/transfers.ts';
import { errorResponses } from '../../errors.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const TransferSchema = z
  .object({
    id: z.uuid(),
    token: z.enum(['USDC', 'USDT']),
    tokenAddress: Address,
    direction: z.enum(['IN', 'OUT']).describe('IN: hacia la Safe; OUT: desde la Safe'),
    counterparty: Address,
    amount: z.string().describe('Unidades mínimas del token (6 decimales)'),
    txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    logIndex: z.number().int(),
    blockNumber: z.string(),
    status: z.enum(['MINED', 'CONFIRMED', 'FINALIZED']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Transfer' });

export interface TransferRoutesOptions {
  transfers: TransferService;
}

export const transferRoutes: FastifyPluginCallbackZod<TransferRoutesOptions> = (app, options, done) => {
  app.get(
    '/wallets/:id/transfers',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'listWalletTransfers',
        tags: ['balances'],
        summary: 'Transfers de USDC y USDT desde y hacia la Safe (indexados; más recientes primero, por cursor)',
        security: accountSecurity,
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          before: z.uuid().optional().describe('Cursor: id del último transfer de la página anterior'),
        }),
        response: {
          200: z.object({ items: z.array(TransferSchema), nextCursor: z.uuid().nullable() }),
          ...errorResponses(401, 404),
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return options.transfers.list(session.userId, request.params.id, {
        limit: request.query.limit,
        ...(request.query.before === undefined ? {} : { before: request.query.before }),
      });
    },
  );

  done();
};
