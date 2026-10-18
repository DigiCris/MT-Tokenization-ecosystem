// Grupo `migración` de [B-API] (P15.T06, ADR-026): en los dos listeners, porque firma la credencial sana: U en Wallet
// (OPERATIONS) o R en Recovery (RECOVERY), sobre la wallet vieja en MIGRATING. Exige el caso de operadores aprobado,
// la Safe nueva ACTIVE y la autorización on-chain activa en el PolicyRegistry; devuelve un MIGRATION_TRANSFER por token
// (saldo completo) para firmar, junto con la Safe destino que la app verifica on-chain antes de firmar.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Client } from '../../../db/schema.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import type { MigrationService } from '../../../recovery/migration.ts';
import { errorResponses } from '../../errors.ts';
import { operationActor, PreparedOperationSchema } from './operations.ts';

const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];

export const MigrationCaseSchema = z
  .object({
    id: z.uuid(),
    oldWalletId: z.uuid(),
    newWalletId: z.uuid().nullable(),
    userId: z.uuid(),
    healthyRole: z.enum(['U', 'R']).describe('Credencial sana: la que firma la migración y conserva su rol'),
    reason: z.string(),
    status: z.enum(['REQUESTED', 'APPROVED', 'COMPLETED', 'CANCELLED']),
    requestedBy: z.uuid(),
    approvalActionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MigrationCase' });

export interface MigrationRoutesOptions {
  client: Client;
  migrations: MigrationService;
}

export const migrationRoutes: FastifyPluginCallbackZod<MigrationRoutesOptions> = (app, options, done) => {
  const scopes = options.client === 'WALLET' ? (['OPERATIONS'] as const) : (['RECOVERY'] as const);

  app.post(
    '/wallets/:id/migration/prepare',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes, critical: true } },
      schema: {
        operationId: 'prepareMigration',
        tags: ['migration'],
        summary:
          'Migración excepcional: con el caso aprobado y la autorización on-chain activa, prepara los MIGRATION_TRANSFER del saldo completo hacia la Safe nueva',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: z.object({ id: z.uuid() }),
        body: z.object({}).strict(),
        response: {
          200: z
            .object({
              case: MigrationCaseSchema,
              destination: z.object({ walletId: z.uuid(), safe: z.string() }),
              operations: z.array(PreparedOperationSchema),
            })
            .meta({ id: 'MigrationPrepared' }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return options.migrations.prepare(actor, request.params.id);
    },
  );

  done();
};
